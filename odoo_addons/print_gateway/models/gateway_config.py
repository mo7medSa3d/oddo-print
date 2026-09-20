# -*- coding: utf-8 -*-
"""Minimal Gateway connection configuration for the Odoo integration."""

from urllib.parse import urlparse

import logging
import os
import requests

from .crypto import (
    CredentialDecryptError,
    CredentialKeyUnavailable,
    active_gateway_api_key_version,
    decrypt_gateway_api_key,
    encrypt_gateway_api_key,
    gateway_api_key_version,
    is_encrypted_gateway_api_key,
)

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError

_logger = logging.getLogger(__name__)


class PrintGatewayConfig(models.Model):
    _name = "print_gateway.gateway_config"
    _description = "Print Gateway Configuration"
    _order = "company_id"

    company_id = fields.Many2one(
        "res.company", string="Company", required=True,
        domain="[('parent_id', '=', False)]",
        default=lambda self: (self.env.company.parent_id or self.env.company),
        ondelete="restrict", index=True,
    )
    enabled = fields.Boolean(string="Gateway Printing Enabled", default=False)
    enabled_sync_revision = fields.Integer(
        string="Activation Sync Revision", default=0, readonly=True, copy=False,
    )
    last_enabled_sync_revision = fields.Integer(
        string="Last Gateway Sync Revision", default=-1, readonly=True, copy=False,
    )
    last_enabled_sync_at = fields.Datetime(readonly=True, copy=False)
    last_enabled_sync_error = fields.Text(readonly=True, copy=False)
    # Durable one-item migration state for Gateway URL changes. The previous
    # endpoint is explicitly disabled before the new endpoint is reconciled.
    # A second URL migration is blocked while this state is pending, preventing
    # remote endpoint drift and keeping reconciliation deterministic.
    pending_disable_gateway_url = fields.Char(readonly=True, copy=False, groups="base.group_system")
    pending_disable_gateway_api_key = fields.Char(
        readonly=True,
        copy=False,
        exportable=False,
        groups="base.group_system",
    )
    pending_disable_revision = fields.Integer(readonly=True, copy=False, default=-1)
    last_gateway_migration_sync_at = fields.Datetime(readonly=True, copy=False)
    last_gateway_migration_sync_error = fields.Text(readonly=True, copy=False)
    gateway_url = fields.Char(string="Gateway URL", required=True)
    gateway_api_key = fields.Char(
        string="API Key",
        copy=False,
        exportable=False,
        groups="base.group_system",
        help="Gateway installation credential. Restricted to system administrators and excluded from exports; database-at-rest encryption requires the deployment's secret-management boundary.",
    )
    runtime_agent_id = fields.Char(
        string="Legacy Runtime Agent Reference",
        copy=False,
        groups="base.group_system",
        help="Backward-compatible opaque Gateway runtime-agent reference from the earlier configuration model. New branch bindings do not use this field as their source of truth.",
    )
    last_test_at = fields.Datetime(readonly=True)
    last_test_status = fields.Selection(
        [("draft", "Untested"), ("success", "Success"), ("failed", "Failed"),
         ("revoked", "Revoked / Deleted on Gateway")],
        readonly=True, default="draft",
    )
    last_test_error = fields.Text(readonly=True)
    gateway_sync_state = fields.Selection(
        [
            ("active", "Active"),
            ("disabled", "Disabled"),
            ("syncing", "Syncing"),
            ("attention", "Action needed"),
            ("not_configured", "Setup required"),
        ],
        string="Gateway Status",
        compute="_compute_gateway_sync_state",
        readonly=True,
    )
    gateway_sync_message = fields.Char(
        string="Status details",
        compute="_compute_gateway_sync_state",
        readonly=True,
    )

    _company_unique = models.Constraint(
        "UNIQUE(company_id)",
        "Only one Print Gateway configuration is allowed per Odoo company.",
    )

    @classmethod
    def _validate_gateway_host(cls, hostname, *, resolve=False):
        # Zero-configuration: any hostname or IP (LAN, public, loopback,
        # DNS) is accepted. Kept as a no-op so older tests/tools that patch
        # this hook keep working.
        return None

    @classmethod
    def _validate_gateway_url(cls, value, *, resolve_host=False):
        if not value or not isinstance(value, str):
            raise ValidationError(_("Gateway URL is required."))
        raw = value.strip()
        if len(raw) > 2048 or "\r" in raw or "\n" in raw:
            raise ValidationError(_("Gateway URL is invalid."))
        parsed = urlparse(raw)
        scheme = parsed.scheme.lower()
        if scheme not in ("http", "https") or not parsed.hostname:
            raise ValidationError(_("Gateway URL must use HTTP or HTTPS and include a host."))
        if scheme == "http" and os.environ.get("ODOO_PRINT_GATEWAY_ALLOW_INSECURE_HTTP") != "1":
            raise ValidationError(_("Gateway URL must use HTTPS. Plain HTTP is allowed only for explicitly opted-in isolated development."))
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValidationError(_("Gateway URL must not contain credentials, query parameters, or fragments."))
        if parsed.path not in ("", "/"):
            raise ValidationError(_("Gateway URL must be the Gateway origin, without an API path."))
        return raw.rstrip("/")

    @api.depends(
        "enabled",
        "gateway_api_key",
        "last_test_status",
        "last_enabled_sync_error",
        "enabled_sync_revision",
        "last_enabled_sync_revision",
    )
    def _compute_gateway_sync_state(self):
        for record in self:
            if not record.gateway_api_key:
                record.gateway_sync_state = "not_configured"
                record.gateway_sync_message = _(
                    "Add an installation API key to connect this Odoo company to the Gateway."
                )
                continue
            if record.last_test_status == "revoked":
                record.gateway_sync_state = "attention"
                record.gateway_sync_message = _(
                    "The Gateway API key is no longer valid. Replace the key, then test the connection."
                )
                continue
            if record.last_enabled_sync_error:
                record.gateway_sync_state = "attention"
                record.gateway_sync_message = _(
                    "Odoo is set to %s, but the Gateway has not confirmed that state yet."
                ) % (_("enabled") if record.enabled else _("disabled"))
                continue
            if int(record.last_enabled_sync_revision or -1) != int(record.enabled_sync_revision or 0):
                record.gateway_sync_state = "syncing"
                record.gateway_sync_message = _(
                    "Sending the current Odoo activation state to the Gateway."
                )
                continue
            if record.enabled:
                record.gateway_sync_state = "active"
                record.gateway_sync_message = _(
                    "Printing is enabled in Odoo and the Gateway has confirmed the current state."
                )
            else:
                record.gateway_sync_state = "disabled"
                record.gateway_sync_message = _(
                    "Printing is disabled in Odoo and the Gateway has confirmed the current state."
                )

    @api.constrains("company_id")
    def _check_company_id(self):
        for record in self:
            if record.company_id and record.company_id.parent_id:
                raise ValidationError(
                    _("Gateway Configuration can only be created for parent companies, not branches (%s).")
                    % record.company_id.display_name
                )

    @api.constrains("gateway_url")
    def _check_gateway_url(self):
        for record in self:
            self._validate_gateway_url(record.gateway_url)

    @api.constrains("runtime_agent_id")
    def _check_runtime_agent_id(self):
        for record in self:
            if record.runtime_agent_id and (not isinstance(record.runtime_agent_id, str) or not record.runtime_agent_id.strip()):
                raise ValidationError(_("Legacy Runtime Agent must be a non-empty Gateway agent ID."))

    def _gateway_base(self, *, for_request=False):
        self.ensure_one()
        return self._validate_gateway_url(self.gateway_url, resolve_host=for_request)

    @staticmethod
    def _protected_gateway_api_key(value):
        if not value:
            return value
        if is_encrypted_gateway_api_key(value):
            version = gateway_api_key_version(value)
            active = active_gateway_api_key_version()
            if version != active:
                return encrypt_gateway_api_key(decrypt_gateway_api_key(value))
            # Validate that the active key can actually authenticate the stored value.
            decrypt_gateway_api_key(value)
            return value
        return encrypt_gateway_api_key(value)

    @classmethod
    def _gateway_api_key_plaintext_from_value(cls, value):
        if not value:
            return ""
        try:
            return decrypt_gateway_api_key(value)
        except (CredentialKeyUnavailable, CredentialDecryptError, ValueError) as exc:
            raise ValidationError(_("Gateway credential protection is unavailable or invalid.")) from exc

    def _gateway_api_key_plaintext(self):
        self.ensure_one()
        if not self.gateway_api_key:
            raise ValidationError(_("Gateway API key is not configured."))
        try:
            protected = self._protected_gateway_api_key(self.gateway_api_key)
            if protected != self.gateway_api_key:
                self.with_context(skip_enabled_sync=True).sudo().write({"gateway_api_key": protected})
                self.invalidate_recordset(["gateway_api_key"])
            return decrypt_gateway_api_key(self.gateway_api_key)
        except (CredentialKeyUnavailable, CredentialDecryptError, ValueError) as exc:
            raise ValidationError(
                _("Gateway credential protection is unavailable or invalid. Configure the deployment-managed credential encryption key before using Gateway printing.")
            ) from exc

    def _gateway_headers(self):
        self.ensure_one()
        api_key = self._gateway_api_key_plaintext()
        return {
            "Authorization": "Bearer %s" % api_key,
            "Accept": "application/json",
            "Cache-Control": "no-store",
            "X-Odoo-Database": self.env.cr.dbname,
        }

    def _persist_gateway_migration_result(self, *, success, error):
        """Persist old-endpoint migration bookkeeping with an independent cursor."""
        self.ensure_one()
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, api.SUPERUSER_ID, {})
            config = env["print_gateway.gateway_config"].browse(self.id).exists()
            if config:
                if success:
                    # Old-endpoint shutdown is only phase 1. Keep the pending
                    # migration record until the NEW endpoint has acknowledged
                    # the same revision and desired enabled state; otherwise a
                    # second URL change could race between the two phases and
                    # leave an uncontrolled split-brain configuration.
                    config.with_context(skip_enabled_sync=True).write({
                        "last_gateway_migration_sync_at": fields.Datetime.now(),
                        "last_gateway_migration_sync_error": False,
                    })
                else:
                    config.with_context(skip_enabled_sync=True).write({
                        "last_gateway_migration_sync_error": (error or "")[:4000],
                    })
            cr.commit()
        except Exception:
            cr.rollback()
            _logger.exception("Could not persist Gateway URL migration result for config %s", self.id)
        finally:
            cr.close()

    def _complete_gateway_migration(self, revision):
        """Clear the durable migration fence only after the new endpoint converges."""
        self.ensure_one()
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, api.SUPERUSER_ID, {})
            config = env["print_gateway.gateway_config"].browse(self.id).exists()
            if config and int(config.pending_disable_revision or -1) == int(revision):
                config.with_context(skip_enabled_sync=True).write({
                    "pending_disable_gateway_url": False,
                    "pending_disable_gateway_api_key": False,
                    "pending_disable_revision": -1,
                    "last_gateway_migration_sync_at": fields.Datetime.now(),
                    "last_gateway_migration_sync_error": False,
                })
            cr.commit()
        except Exception:
            cr.rollback()
            _logger.exception("Could not complete Gateway URL migration for config %s", self.id)
        finally:
            cr.close()

    def _sync_pending_gateway_disable(self, *, gateway_url, api_key, revision):
        """Disable the old endpoint; only an explicit enabled=false is success."""
        self.ensure_one()
        try:
            response = requests.patch(
                "%s/api/odoo/configuration" % gateway_url,
                headers={
                    "Authorization": "Bearer %s" % api_key,
                    "Accept": "application/json",
                    "Cache-Control": "no-store",
                    "Content-Type": "application/json",
                    "X-Odoo-Database": self.env.cr.dbname,
                },
                json={"enabled": False, "revision": int(revision)},
                timeout=10,
                allow_redirects=False,
            )
            if response.status_code == 401:
                raise ValidationError(
                    _("The previous Gateway rejected shutdown synchronization because its stored API key is unauthorized.")
                )
            body = response.json() if response.content else {}
            if (
                response.status_code != 200
                or not isinstance(body, dict)
                or body.get("ok") is not True
                or body.get("enabled") is not False
            ):
                message = body.get("error") if isinstance(body, dict) else False
                raise ValidationError(
                    message
                    or _("The previous Gateway did not confirm that Odoo integration was disabled (HTTP %s).")
                    % response.status_code
                )
            acknowledged_revision = body.get("revision")
            if not isinstance(acknowledged_revision, int) or acknowledged_revision < -1:
                raise ValidationError(_("The previous Gateway returned an invalid migration revision."))
            self._persist_gateway_migration_result(success=True, error=None)
            _logger.info(
                "Gateway URL migration disabled previous endpoint for config %s at revision %s",
                self.id,
                acknowledged_revision,
            )
            return True
        except (ValidationError, requests.RequestException, ValueError) as exc:
            message = str(exc)[:4000]
            self._persist_gateway_migration_result(success=False, error=message)
            _logger.warning(
                "Gateway URL migration could not disable previous endpoint for config %s: %s",
                self.id,
                exc,
            )
            return False

    def _run_postcommit_enabled_sync(
        self,
        *,
        gateway_url,
        api_key,
        dbname,
        revision,
        enabled,
        pending_disable=None,
    ):
        """Reconcile old endpoint shutdown before the new endpoint state."""
        if pending_disable:
            old_url, old_api_key, old_revision = pending_disable
            if not self._sync_pending_gateway_disable(
                gateway_url=old_url,
                api_key=old_api_key,
                revision=old_revision,
            ):
                return
        synced = self._sync_enabled_state_to_gateway(
            gateway_url,
            api_key,
            dbname,
            revision,
            enabled,
        )
        if synced and pending_disable:
            self._complete_gateway_migration(revision)
        return synced

    def _sync_enabled_state_to_gateway(
        self,
        gateway_url,
        api_key,
        dbname,
        expected_revision,
        expected_enabled,
    ):
        """Push Odoo activation state and persist the result on a fresh cursor."""
        self.ensure_one()
        revision = int(expected_revision)
        enabled = bool(expected_enabled)
        try:
            response = requests.patch(
                "%s/api/odoo/configuration" % gateway_url,
                headers={
                    "Authorization": "Bearer %s" % api_key,
                    "Accept": "application/json",
                    "Cache-Control": "no-store",
                    "Content-Type": "application/json",
                    "X-Odoo-Database": dbname,
                },
                json={"enabled": enabled, "revision": revision},
                timeout=10,
                allow_redirects=False,
            )
            # Do not parse an authentication-failure body: a revoked/deleted
            # API key may return HTML or an empty response. The sync worker
            # records the failure and the retry cron can converge after a new
            # key is configured.
            if response.status_code == 401:
                raise ValidationError(_("Gateway activation synchronization was rejected because the API key is unauthorized."))
            body = response.json() if response.content else {}
            if response.status_code != 200 or not isinstance(body, dict) or body.get("ok") is not True:
                message = body.get("error") if isinstance(body, dict) else False
                raise ValidationError(
                    message or _("Gateway activation synchronization failed (HTTP %s).") % response.status_code
                )
            acknowledged_revision = body.get("revision")
            acknowledged_enabled = body.get("enabled")
            if not isinstance(acknowledged_revision, int) or acknowledged_revision < 0:
                raise ValidationError(_("Gateway activation synchronization returned an invalid revision."))
            # A 200 stale-revision response is informational, not convergence.
            # Only an exact revision + state acknowledgement completes this
            # synchronization phase. This is critical during URL migration:
            # otherwise the new endpoint could be left disabled/stale while
            # Odoo clears the migration fence.
            if acknowledged_revision != revision or acknowledged_enabled is not enabled:
                raise ValidationError(
                    _("Gateway activation synchronization did not acknowledge the requested revision/state.")
                )
            self._persist_enabled_sync_result(
                dbname,
                success=True,
                revision=acknowledged_revision,
                error=False,
            )
            return True
        except (ValidationError, requests.RequestException, ValueError) as exc:
            message = str(exc)[:4000]
            self._persist_enabled_sync_result(
                dbname,
                success=False,
                revision=None,
                error=message,
            )
            _logger.warning("Gateway activation synchronization failed for config %s: %s", self.id, exc)
            return False

    def _persist_enabled_sync_result(self, dbname, *, success, revision, error):
        """Persist post-commit sync bookkeeping using an independent cursor."""
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, api.SUPERUSER_ID, {})
            config = env["print_gateway.gateway_config"].browse(self.id).exists()
            if config:
                values = {"last_enabled_sync_error": error or False}
                if success:
                    values.update({
                        "last_enabled_sync_revision": int(revision),
                        "last_enabled_sync_at": fields.Datetime.now(),
                    })
                config.write(values)
            cr.commit()
        except Exception:
            cr.rollback()
            _logger.exception("Could not persist Gateway activation sync result for config %s", self.id)
        finally:
            cr.close()

    def _queue_enabled_state_sync(self, credential_overrides=None):
        credential_overrides = credential_overrides or {}
        for record in self:
            override = credential_overrides.get(record.id)
            if override:
                gateway_url, api_key = override
            else:
                if not record.gateway_api_key:
                    continue
                gateway_url = record._gateway_base(for_request=True)
                api_key = record._gateway_api_key_plaintext()
            record_id = record.id
            dbname = self.env.cr.dbname
            revision = int(record.enabled_sync_revision or 0)
            enabled = bool(record.enabled)
            pending_disable = None
            has_pending_disable_state = bool(
                record.pending_disable_gateway_url
                or record.pending_disable_gateway_api_key
                or int(record.pending_disable_revision or -1) >= 0
            )
            if has_pending_disable_state:
                if not (
                    record.pending_disable_gateway_url
                    and record.pending_disable_gateway_api_key
                    and int(record.pending_disable_revision or -1) >= 0
                ):
                    raise ValidationError(
                        _("Gateway endpoint shutdown/migration state is incomplete; automatic reconciliation is blocked until it is repaired.")
                    )
                pending_disable = (
                    record.pending_disable_gateway_url,
                    record._gateway_api_key_plaintext_from_value(record.pending_disable_gateway_api_key),
                    int(record.pending_disable_revision),
                )
            self.env.cr.postcommit.add(
                lambda record_id=record_id, gateway_url=gateway_url, api_key=api_key,
                       dbname=dbname, revision=revision, enabled=enabled,
                       pending_disable=pending_disable:
                    self.browse(record_id)._run_postcommit_enabled_sync(
                        gateway_url=gateway_url,
                        api_key=api_key,
                        dbname=dbname,
                        revision=revision,
                        enabled=enabled,
                        pending_disable=pending_disable,
                    )
            )

    def _check_admin(self):
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only Odoo system administrators can change Gateway configuration."))

    def write(self, vals):
        sync_fields = {"enabled", "gateway_url", "gateway_api_key"}
        skip_enabled_sync = bool(self.env.context.get("skip_enabled_sync"))
        if set(vals).intersection({"gateway_url", "gateway_api_key", "enabled", "company_id", "runtime_agent_id"}):
            self._check_admin()

        vals = dict(vals)

        # URL migration is a durable state machine. Serialize concurrent writes
        # per configuration row before reading the previous endpoint/revision;
        # otherwise two simultaneous URL changes can both observe the same old
        # state and the later transaction can overwrite the first pending
        # shutdown record, losing an endpoint that still may be active.
        if self.ids:
            self.flush_recordset()
            self.env.cr.execute(
                f"SELECT id FROM {self._table} WHERE id IN %s FOR UPDATE",
                [tuple(self.ids)],
            )
            self.invalidate_recordset([
                "gateway_url",
                "gateway_api_key",
                "enabled",
                "enabled_sync_revision",
                "last_enabled_sync_revision",
                "last_enabled_sync_error",
                "pending_disable_gateway_url",
                "pending_disable_gateway_api_key",
                "pending_disable_revision",
            ])

        before_enabled = {record.id: bool(record.enabled) for record in self}
        before_gateway_url = {record.id: record.gateway_url for record in self}
        before_revision = {record.id: int(record.enabled_sync_revision or 0) for record in self}
        pre_sync_credentials = {}
        if "gateway_api_key" in vals and not vals["gateway_api_key"]:
            for record in self:
                if not record.gateway_api_key:
                    continue
                if record.pending_disable_gateway_url:
                    raise ValidationError(
                        _("The API key cannot be removed while a previous Gateway migration is still pending.")
                    )
                remote_may_still_be_enabled = bool(
                    record.enabled
                    or record.last_enabled_sync_error
                    or int(record.last_enabled_sync_revision or -1) != before_revision[record.id]
                )
                try:
                    pre_sync_credentials[record.id] = (
                        record._gateway_base(for_request=True),
                        record._gateway_api_key_plaintext(),
                    )
                except (ValidationError, ValueError, CredentialKeyUnavailable, CredentialDecryptError) as exc:
                    if remote_may_still_be_enabled:
                        raise ValidationError(
                            _("The existing Gateway API key cannot be decrypted, so Odoo will not remove it while the Gateway may still be active.")
                        ) from exc
        url_migrations = {}
        key_removals = dict(pre_sync_credentials)

        if "gateway_url" in vals:
            requested_url = self._validate_gateway_url(vals.get("gateway_url"))
            for record in self:
                old_url = self._validate_gateway_url(before_gateway_url.get(record.id))
                if requested_url == old_url:
                    continue
                if record.pending_disable_gateway_url:
                    raise ValidationError(
                        _("Gateway URL cannot be changed again until the previous Gateway endpoint has been successfully disabled.")
                    )

                needs_old_disable = bool(
                    record.enabled
                    or record.last_enabled_sync_error
                    or int(record.last_enabled_sync_revision or -1) != before_revision[record.id]
                )
                if needs_old_disable and not record.gateway_api_key:
                    raise ValidationError(
                        _("Cannot change the Gateway URL while the previous Gateway state may still be active without a stored API key.")
                    )
                if needs_old_disable:
                    try:
                        old_api_key = record._gateway_api_key_plaintext()
                        old_api_key_protected = self._protected_gateway_api_key(old_api_key)
                    except (ValidationError, ValueError, CredentialKeyUnavailable, CredentialDecryptError) as exc:
                        raise ValidationError(
                            _("Cannot change the Gateway URL until the previous Gateway credential can be decrypted and protected for migration.")
                        ) from exc
                    url_migrations[record.id] = (old_url, old_api_key_protected)
                else:
                    url_migrations[record.id] = None

        if "gateway_api_key" in vals and vals["gateway_api_key"]:
            try:
                vals["gateway_api_key"] = self._protected_gateway_api_key(vals["gateway_api_key"])
            except (CredentialKeyUnavailable, CredentialDecryptError, ValueError) as exc:
                raise ValidationError(
                    _("Gateway credential protection is unavailable. Configure the deployment-managed credential encryption key before saving an API key.")
                ) from exc

        result = super().write(vals)

        if sync_fields.intersection(vals) and not skip_enabled_sync:
            for record in self:
                enabled_changed = "enabled" in vals and before_enabled.get(record.id) != bool(record.enabled)
                url_changed = record.id in url_migrations
                api_key_changed = "gateway_api_key" in vals
                key_removed = api_key_changed and not vals.get("gateway_api_key")
                if url_changed or enabled_changed or api_key_changed:
                    new_revision = before_revision[record.id] + 1
                    technical_values = {
                        "enabled_sync_revision": new_revision,
                        "last_enabled_sync_error": False,
                    }
                    migration = url_migrations.get(record.id)
                    pending_disable = migration if url_changed else (key_removals.get(record.id) if key_removed else None)
                    if pending_disable:
                        old_url, old_api_key_protected = pending_disable
                        technical_values.update({
                            "pending_disable_gateway_url": old_url,
                            "pending_disable_gateway_api_key": old_api_key_protected,
                            "pending_disable_revision": new_revision,
                            "last_gateway_migration_sync_error": False,
                        })
                    elif url_changed or key_removed:
                        technical_values.update({
                            "pending_disable_gateway_url": False,
                            "pending_disable_gateway_api_key": False,
                            "pending_disable_revision": -1,
                            "last_gateway_migration_sync_error": False,
                        })
                    record.sudo().write(technical_values)
                elif "gateway_api_key" in vals:
                    record.sudo().write({"last_enabled_sync_error": False})
            self._queue_enabled_state_sync(pre_sync_credentials)

        return result

    @api.model_create_multi
    def create(self, vals_list):
        self._check_admin()
        normalized = []
        for original in vals_list:
            vals = dict(original)
            vals.setdefault("company_id", (self.env.company.parent_id or self.env.company).id)
            self._validate_gateway_url(vals.get("gateway_url"))
            if vals.get("gateway_api_key"):
                try:
                    vals["gateway_api_key"] = self._protected_gateway_api_key(vals["gateway_api_key"])
                except (CredentialKeyUnavailable, CredentialDecryptError, ValueError) as exc:
                    raise ValidationError(
                        _("Gateway credential protection is unavailable. Configure the deployment-managed credential encryption key before creating a Gateway configuration.")
                    ) from exc
            normalized.append(vals)
        records = super().create(normalized)
        records._queue_enabled_state_sync()
        return records

    def unlink(self):
        self._check_admin()
        return super().unlink()

    @api.model
    @api.private
    def cron_sync_enabled_state(self):
        """Retry activation replication, including pending old-endpoint shutdowns."""
        # Include pending migrations even when the CURRENT Gateway API
        # key has already been cleared. The old encrypted credential is enough
        # to finish disabling the previous endpoint safely.
        configs = self.sudo().search([
            "|",
            ("gateway_url", "!=", False),
            ("pending_disable_gateway_url", "!=", False),
        ])
        for config in configs:
            if (
                config.pending_disable_gateway_url
                and config.pending_disable_gateway_api_key
                and int(config.pending_disable_revision or -1) >= 0
            ):
                try:
                    old_api_key = config._gateway_api_key_plaintext_from_value(
                        config.pending_disable_gateway_api_key
                    )
                    if not config._sync_pending_gateway_disable(
                        gateway_url=config.pending_disable_gateway_url,
                        api_key=old_api_key,
                        revision=int(config.pending_disable_revision),
                    ):
                        continue
                    if not config.gateway_api_key:
                        config._complete_gateway_migration(
                            int(config.pending_disable_revision or -1)
                        )
                        continue
                except (ValidationError, requests.RequestException, ValueError) as exc:
                    config._persist_gateway_migration_result(success=False, error=str(exc))
                    _logger.warning(
                        "Gateway endpoint shutdown retry failed for config %s: %s",
                        config.id,
                        exc,
                    )
                    continue

            if (
                config.gateway_url
                and config.gateway_api_key
                and (
                    int(config.last_enabled_sync_revision or -1) != int(config.enabled_sync_revision or 0)
                    or bool(config.last_enabled_sync_error)
                )
            ):
                try:
                    gateway_url = config._gateway_base(for_request=True)
                    api_key = config._gateway_api_key_plaintext()
                    revision = int(config.enabled_sync_revision or 0)
                    if config._sync_enabled_state_to_gateway(
                        gateway_url,
                        api_key,
                        self.env.cr.dbname,
                        revision,
                        bool(config.enabled),
                    ) and config.pending_disable_gateway_url:
                        config._complete_gateway_migration(revision)
                except (ValidationError, requests.RequestException, ValueError) as exc:
                    message = str(exc)[:4000]
                    config._persist_enabled_sync_result(
                        self.env.cr.dbname,
                        success=False,
                        revision=None,
                        error=message,
                    )
                    _logger.warning(
                        "Gateway activation reconciliation failed for config %s: %s",
                        config.id,
                        exc,
                    )
        return True

    def action_test_connection(self):
        self.ensure_one()
        self._check_admin()
        try:
            response = requests.get(
                "%s/api/odoo/health" % self._gateway_base(for_request=True),
                headers=self._gateway_headers(),
                timeout=10,
                allow_redirects=False,
            )
            # Authentication failure semantics are deterministic and must not
            # depend on the Gateway returning a JSON body. Check 401 before
            # parsing the response so malformed/error HTML cannot erase the
            # explicit revoked state.
            if response.status_code == 401:
                # The installation API key was revoked or deleted on the
                # Gateway. Keep the explicit revoked state; the generic
                # ValidationError handler below must not overwrite it with
                # the less-specific failed state.
                message = _("API Key has been revoked or deleted from the Gateway. Printing is disabled. Paste a new key or press Clear / Remove Key, then test again.")
                self.write({
                    "last_test_at": fields.Datetime.now(),
                    "last_test_status": "revoked",
                    "last_test_error": message,
                    "enabled": False,
                })
                # Do not raise after persisting the state: an Odoo exception
                # rolls back the transaction, which would erase the revoked
                # marker we just stored. Return a warning notification instead.
                return {
                    "type": "ir.actions.client",
                    "tag": "display_notification",
                    "params": {"title": _("Gateway Connection"), "message": message, "type": "warning", "sticky": True},
                }

            # Only successful/other non-auth responses need JSON decoding.
            # A malformed success response is handled by the ValueError path.
            body = response.json() if response.content else {}
            if response.status_code != 200 or not isinstance(body, dict) or body.get("ok") is not True:
                raise ValidationError(_("Gateway connection test failed (HTTP %s).") % response.status_code)
            self.write({"last_test_at": fields.Datetime.now(), "last_test_status": "success", "last_test_error": False})
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {"title": _("Gateway Connection"), "message": _("Gateway is reachable and the installation API key is valid."), "type": "success", "sticky": False},
            }
        except ValidationError as exc:
            self.write({"last_test_at": fields.Datetime.now(), "last_test_status": "failed", "last_test_error": str(exc)[:4000]})
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {"title": _("Gateway Connection"), "message": str(exc), "type": "danger", "sticky": True},
            }
        except requests.RequestException as exc:
            msg = _("Gateway is unavailable or the connection timed out.")
            self.write({"last_test_at": fields.Datetime.now(), "last_test_status": "failed", "last_test_error": msg})
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {"title": _("Gateway Connection"), "message": msg, "type": "danger", "sticky": True},
            }
        except ValueError as exc:
            msg = _("Gateway returned an invalid health response.")
            self.write({"last_test_at": fields.Datetime.now(), "last_test_status": "failed", "last_test_error": msg})
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {"title": _("Gateway Connection"), "message": msg, "type": "danger", "sticky": True},
            }

    def action_clear_api_key(self):
        """Remove the stored installation API key and reset test state."""
        self.ensure_one()
        self._check_admin()
        self.write({
            "gateway_api_key": False,
            "last_test_status": "draft",
            "last_test_error": False,
            "enabled": False,
        })
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {"title": _("API Key"), "message": _("The installation API key was removed. Printing is disabled until a new key is configured and tested."), "type": "warning", "sticky": False},
        }

    def action_open_pairing_wizard(self):
        self.ensure_one()
        self._check_admin()
        return {
            "type": "ir.actions.act_window",
            "name": _("Pair New Agent"),
            "res_model": "print_gateway.pair_agent_wizard",
            "view_mode": "form",
            "target": "new",
            "context": {"default_config_id": self.id},
        }

    def action_open_runtime_assignments(self):
        """Navigation only: open the branch → agent assignments for this company."""
        self.ensure_one()
        return {
            "type": "ir.actions.act_window",
            "name": _("Branch Agent Assignments"),
            "res_model": "print_gateway.runtime_agent_assignment",
            "view_mode": "list,form",
            "domain": [("company_id", "=", self.company_id.id)],
            "context": {"default_company_id": self.company_id.id},
        }


class PrintGatewayPairAgentWizard(models.TransientModel):
    _name = "print_gateway.pair_agent_wizard"
    _description = "Assign Runtime Agent Wizard"

    config_id = fields.Many2one("print_gateway.gateway_config", string="Gateway Configuration", required=True)
    company_id = fields.Many2one("res.company", related="config_id.company_id", readonly=True)
    branch_id = fields.Many2one(
        "res.company", string="Target Branch",
        domain="[('parent_id', '=', company_id)]",
        default=False,
        required=False,
    )
    agent_id = fields.Char(
        string="Runtime Agent ID",
        help="Identifier of an active Agent registered with the Central Gateway.",
    )
    pairing_code = fields.Char(
        string="Agent Reference / ID",
        help="Identifier or name of the Agent to assign to this branch.",
    )

    def action_confirm_pairing(self):
        self.ensure_one()
        target = (self.agent_id or self.pairing_code or "").strip()
        if not target:
            raise ValidationError(_("Please provide a valid Runtime Agent ID."))
        config = self.config_id
        try:
            response = requests.get(
                "%s/api/odoo/agents" % config._gateway_base(for_request=True),
                headers=config._gateway_headers(),
                timeout=10,
                allow_redirects=False,
            )
            if response.status_code in (401, 403):
                raise ValidationError(_("Gateway authentication failed. Please check your Gateway API key."))
            if response.status_code != 200:
                raise ValidationError(_("Gateway agent discovery failed (HTTP %s).") % response.status_code)
            body = response.json() if response.content else {}
            agents_list = body.get("agents") if isinstance(body, dict) else []
            matched = next(
                (a for a in agents_list if isinstance(a, dict) and (a.get("id") == target or a.get("name") == target)),
                None,
            )
            if not matched:
                available = [a.get("id") for a in agents_list if isinstance(a, dict) and a.get("id")]
                raise ValidationError(
                    _("Agent '%s' not found on Central Gateway. Registered active agents: %s")
                    % (target, ", ".join(available) if available else _("none"))
                )
            if matched.get("lifecycle") != "active":
                raise ValidationError(
                    _("Agent '%s' cannot be assigned because its status is '%s'. Only active agents are allowed.")
                    % (matched.get("name") or target, matched.get("lifecycle"))
                )
            resolved_agent_id = matched["id"]
            # A branch may intentionally have multiple assigned Agents.
            # Company-level assignment is represented with branch_id=False.
            if self.branch_id:
                if self.branch_id.parent_id != config.company_id:
                    raise ValidationError(
                        _("The selected Target Branch must belong directly to the configured Odoo Company.")
                    )
                target_branch = self.branch_id
            else:
                target_branch = False
            assignment_model = self.env["print_gateway.runtime_agent_assignment"]
            existing = assignment_model.search([
                ("company_id", "=", config.company_id.id),
                ("branch_id", "=", target_branch.id if target_branch else False),
                ("runtime_agent_id", "=", resolved_agent_id),
            ], limit=1)
            if not existing:
                assignment_model.create({
                    "company_id": config.company_id.id,
                    "branch_id": target_branch.id if target_branch else False,
                    "runtime_agent_id": resolved_agent_id,
                    "enabled": True,
                })
            target_scope = target_branch.display_name if target_branch else config.company_id.display_name
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("Agent Assigned Successfully"),
                    "message": _("Agent %s assigned to %s.") % (resolved_agent_id, target_scope),
                    "type": "success",
                    "sticky": False,
                },
            }
        except ValidationError:
            raise
        except requests.RequestException as exc:
            raise ValidationError(_("Gateway connection timed out while querying registered agents.")) from exc


