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


def _friendly_gateway_request_error(exc, gateway_url):
    """Turn a raw requests failure into an operator-actionable message.

    Transport failures name the URL and hint at host/port instead of dumping
    pool internals, so a wrong Gateway origin is diagnosable from the Odoo
    form instead of surfacing as a generic sync stall.
    """
    url = gateway_url or _("the configured Gateway URL")
    if isinstance(exc, requests.exceptions.ConnectionError):
        return _(
            "Could not reach the Gateway at %(url)s. Verify the URL host and port "
            "match the Gateway deployment (scheme, host and explicit port, without an API path) "
            "and that the Gateway is running."
        ) % {"url": url}
    if isinstance(exc, requests.exceptions.Timeout):
        return _(
            "The Gateway at %(url)s did not respond within 10 seconds. Verify the host/port "
            "and the network path between Odoo and the Gateway."
        ) % {"url": url}
    return _(
        "Gateway request to %(url)s failed: %(error)s"
    ) % {"url": url, "error": str(exc)[:1500]}


def _same_gateway_endpoint(url_a, url_b):
    """Compare two Gateway origins, tolerating case/trailing-slash noise."""
    def _canon(value):
        if not value or not isinstance(value, str):
            return ""
        try:
            return PrintGatewayConfig._validate_gateway_url(value)
        except Exception:
            return value.strip().lower().rstrip("/")
    left, right = _canon(url_a), _canon(url_b)
    return bool(left) and left == right


def _gateway_redirect_message(response, gateway_url):
    """Build an actionable message when the Gateway answers with a redirect.

    Sync calls use allow_redirects=False so credentials are never forwarded
    implicitly; a 3xx therefore means the configured origin is wrong (e.g. an
    HTTP URL behind an HTTPS-enforcing proxy) and must be fixed at the source.
    Returns the message, or None when the response is not a redirect.
    """
    if response is None or getattr(response, "status_code", None) not in (301, 302, 303, 307, 308):
        return None
    location = ""
    try:
        location = (response.headers.get("Location") if response.headers else "") or ""
    except Exception:
        location = ""
    return _(
        "The Gateway at %(url)s answered with a redirect (HTTP %(code)s%(location)s). "
        "Configure the final Gateway origin directly (usually the HTTPS URL) instead of an address that redirects."
    ) % {
        "url": gateway_url or _("the configured Gateway URL"),
        "code": response.status_code,
        "location": (_(" to %s") % location) if location else "",
    }


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
    # Canonical pending-sync bookkeeping. The staleness fence must be bound to
    # the revision awaiting confirmation, not to record activity: write_date
    # moves on ANY write and would postpone stale detection while the same
    # revision stays unconfirmed. pending_sync_revision is stamped exactly
    # when a new enabled_sync_revision starts awaiting the Gateway (write
    # bumps and credential rotation alike), and both fields are cleared when
    # an outcome is recorded. Stale rule:
    #   pending_sync_revision != last_enabled_sync_revision
    #   AND now() - pending_sync_started_at >= _SYNC_PENDING_STALE_AFTER_SECONDS
    pending_sync_revision = fields.Integer(
        string="Pending Sync Revision", default=-1, readonly=True, copy=False,
    )
    pending_sync_started_at = fields.Datetime(
        string="Pending Sync Started At", readonly=True, copy=False,
    )
    # Durable one-item shutdown/migration state. The previous endpoint is
    # explicitly disabled before a new endpoint or credential is reconciled.
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
            ("active", "Enabled"),
            ("disabled", "Disabled"),
            ("syncing", "Syncing"),
            ("attention", "Action needed"),
            ("not_configured", "Setup required"),
        ],
        string="Gateway Status",
        compute="_compute_gateway_sync_state",
        store=True,
        index=True,
        readonly=True,
    )
    gateway_sync_message = fields.Char(
        string="Status details",
        compute="_compute_gateway_sync_state",
        readonly=True,
    )

    # "Syncing" must never be an absorbing state. The retry cron runs every
    # minute, so a healthy deployment records an outcome (success OR failure)
    # well within this window. Beyond it the UI escalates to "attention" with
    # an actionable message instead of spinning forever.
    _SYNC_PENDING_STALE_AFTER_SECONDS = 300

    def _pending_stale_message(self):
        return _(
            "Sync did not receive confirmation within %d minutes. Retry Sync or verify Gateway connectivity (URL host and port)."
        ) % (self._SYNC_PENDING_STALE_AFTER_SECONDS // 60)

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
            raise ValidationError(_("Gateway URL must use HTTP or HTTPS and include a host, e.g. https://print.example.com or http://192.0.2.10:3000."))
        if scheme == "http" and os.environ.get("ODOO_PRINT_GATEWAY_ALLOW_INSECURE_HTTP") != "1":
            raise ValidationError(_("Gateway URL must use HTTPS. Plain HTTP is allowed only for explicitly opted-in isolated development."))
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValidationError(_("Gateway URL must not contain credentials, query parameters, or fragments."))
        if parsed.path not in ("", "/"):
            raise ValidationError(_("Gateway URL must be the Gateway origin, without an API path (include the port when the Gateway does not listen on 80/443)."))
        return raw.rstrip("/")

    @api.depends(
        "enabled",
        "gateway_api_key",
        "last_test_status",
        "last_enabled_sync_error",
        "enabled_sync_revision",
        "last_enabled_sync_revision",
        "pending_sync_started_at",
        "pending_disable_gateway_url",
        "last_gateway_migration_sync_error",
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
            if record.pending_disable_gateway_url and record.last_gateway_migration_sync_error:
                # The old-endpoint shutdown fence is blocking the current
                # revision: every retry dies on the previous endpoint, so the
                # new endpoint is never attempted. Previously this error was
                # only visible in logs/columns while the form showed a generic
                # stale message. Surface the real cause with its recovery path.
                record.gateway_sync_state = "attention"
                record.gateway_sync_message = _(
                    "The previous Gateway endpoint (%(url)s) could not be disabled: %(error)s "
                    "Fix the previous endpoint or use Reset Stale Sync, then Retry Sync."
                ) % {
                    "url": record.pending_disable_gateway_url,
                    "error": (record.last_gateway_migration_sync_error or "")[:500],
                }
                continue
            if int(record.last_enabled_sync_revision or -1) != int(record.enabled_sync_revision or 0):
                # The Gateway has not confirmed the current revision yet. The
                # staleness fence is bound to the pending revision's own start
                # timestamp, never to write_date: any unrelated write would
                # otherwise postpone stale detection while the same revision
                # stays unconfirmed.
                # A fresh revision bump always stamps the start time, so a
                # pending row without one predates the fence (legacy row or
                # anomalous state) and is already past any staleness window:
                # escalate instead of spinning.
                started_at = record.pending_sync_started_at
                pending_seconds = (
                    (fields.Datetime.now() - started_at).total_seconds()
                    if started_at
                    else float("inf")
                )
                if pending_seconds > self._SYNC_PENDING_STALE_AFTER_SECONDS:
                    record.gateway_sync_state = "attention"
                    record.gateway_sync_message = self._pending_stale_message()
                    continue
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
            redirect_message = _gateway_redirect_message(response, gateway_url)
            if redirect_message:
                raise ValidationError(redirect_message)
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
        except requests.RequestException as exc:
            message = str(_friendly_gateway_request_error(exc, gateway_url))[:4000]
            self._persist_gateway_migration_result(success=False, error=message)
            _logger.warning(
                "Gateway URL migration could not disable previous endpoint for config %s: %s",
                self.id,
                exc,
            )
            return False
        except (ValidationError, ValueError) as exc:
            message = str(exc)[:4000]
            self._persist_gateway_migration_result(success=False, error=message)
            _logger.warning(
                "Gateway URL migration could not disable previous endpoint for config %s: %s",
                self.id,
                exc,
            )
            return False

    def _pending_disable_credentials(self):
        """Return (url, api_key, revision) for a pending old-endpoint shutdown, or None."""
        self.ensure_one()
        has_pending_disable_state = bool(
            self.pending_disable_gateway_url
            or self.pending_disable_gateway_api_key
            or int(self.pending_disable_revision or -1) >= 0
        )
        if not has_pending_disable_state:
            return None
        if not (
            self.pending_disable_gateway_url
            and self.pending_disable_gateway_api_key
            and int(self.pending_disable_revision or -1) >= 0
        ):
            raise ValidationError(
                _("Gateway endpoint shutdown/migration state is incomplete; automatic reconciliation is blocked until it is repaired.")
            )
        return (
            self.pending_disable_gateway_url,
            self._gateway_api_key_plaintext_from_value(self.pending_disable_gateway_api_key),
            int(self.pending_disable_revision),
        )

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
        """Reconcile old endpoint shutdown before the new endpoint state.

        Post-commit hooks must never die silently: any unexpected crash is
        logged with its traceback AND persisted as a sync error, so the form
        cannot remain stuck on "Syncing" without a visible trail.
        """
        try:
            skipped_same_endpoint_revision = None
            if pending_disable:
                old_url, old_api_key, old_revision = pending_disable
                if self.gateway_api_key and _same_gateway_endpoint(old_url, gateway_url):
                    # Same-endpoint fence (key removed, then a new key added
                    # before the old shutdown completed): the fenced PATCH
                    # below is authoritative for this endpoint, so a separate
                    # disable round-trip is redundant. Skipping it lets a dead
                    # round-trip converge instead of blocking sync forever.
                    # The fence is cleared only after the new state confirms.
                    skipped_same_endpoint_revision = old_revision
                    pending_disable = None
                else:
                    # When the pending shutdown is for the SAME endpoint as the
                    # current configuration, a newly supplied credential can recover
                    # a previous key-removal that was interrupted by key revocation.
                    # URL migrations must still use the credential belonging to the
                    # previous endpoint.
                    shutdown_api_key = old_api_key
                    if self.gateway_api_key and old_url == gateway_url:
                        shutdown_api_key = api_key
                    if not self._sync_pending_gateway_disable(
                        gateway_url=old_url,
                        api_key=shutdown_api_key,
                        revision=old_revision,
                    ):
                        return
                    if not self.gateway_api_key:
                        # A removed key cannot be used for a second no-op PATCH, but
                        # the successful shutdown already proves the requested
                        # disabled state for this revision.
                        self._persist_enabled_sync_result(
                            dbname,
                            success=True,
                            revision=old_revision,
                            error=False,
                            expected_revision=old_revision,
                        )
                        self._complete_gateway_migration(old_revision)
                        return True
            synced = self._sync_enabled_state_to_gateway(
                gateway_url,
                api_key,
                dbname,
                revision,
                enabled,
            )
            if synced and pending_disable:
                self._complete_gateway_migration(revision)
            if synced and skipped_same_endpoint_revision is not None:
                self._complete_gateway_migration(skipped_same_endpoint_revision)
            return synced
        except Exception:  # noqa: BLE001 - a post-commit crash must surface as "attention", never as a silent hang
            _logger.exception(
                "Gateway activation post-commit sync crashed for config %s", self.id
            )
            try:
                self._persist_enabled_sync_result(
                    dbname,
                    success=False,
                    revision=None,
                    error="POSTCOMMIT_ERROR: unexpected synchronization failure (see Odoo server log)",
                    expected_revision=revision,
                )
            except Exception:
                _logger.exception(
                    "Could not persist the post-commit crash marker for config %s", self.id
                )
            return False

    def _reconcile_remote_enabled_revision(
        self,
        *,
        expected_revision,
        remote_revision,
        remote_enabled,
        desired_enabled,
    ):
        """Reconcile an endpoint whose revision is ahead of Odoo's local fence.

        Reconnecting an Odoo configuration to an existing Gateway can legitimately
        encounter a Gateway revision greater than the local Odoo revision. When
        the remote state already matches Odoo, adopt that revision. When it does
        not, advance the local fence beyond the Gateway revision and let the
        normal fenced PATCH apply the desired state. If another local write won
        the race, abort so its newer post-commit sync remains authoritative.
        """
        self.ensure_one()
        remote_revision = int(remote_revision)
        desired_enabled = bool(desired_enabled)
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, api.SUPERUSER_ID, {})
            config = env["print_gateway.gateway_config"].browse(self.id).exists()
            if not config:
                cr.rollback()
                return {"kind": "stale_local"}
            cr.execute(
                "SELECT enabled, enabled_sync_revision FROM %s WHERE id = %%s FOR UPDATE" % self._table,
                [self.id],
            )
            row = cr.fetchone()
            if not row:
                cr.rollback()
                return {"kind": "stale_local"}
            local_enabled = bool(row[0])
            local_revision = int(row[1] or 0)
            if local_revision != int(expected_revision) or local_enabled is not desired_enabled:
                cr.rollback()
                return {"kind": "stale_local"}

            if remote_enabled is desired_enabled and remote_revision >= local_revision:
                config.with_context(skip_enabled_sync=True).write({
                    "enabled_sync_revision": remote_revision,
                    "last_enabled_sync_revision": remote_revision,
                    "last_enabled_sync_at": fields.Datetime.now(),
                    "last_enabled_sync_error": False,
                    "pending_sync_revision": -1,
                    "pending_sync_started_at": False,
                })
                cr.commit()
                return {"kind": "converged", "revision": remote_revision}

            if remote_revision < local_revision:
                cr.rollback()
                return {"kind": "invalid"}

            next_revision = remote_revision + 1
            config.with_context(skip_enabled_sync=True).write({
                "enabled_sync_revision": next_revision,
                "last_enabled_sync_error": False,
                "pending_sync_revision": next_revision,
                "pending_sync_started_at": fields.Datetime.now(),
            })
            cr.commit()
            return {"kind": "retry", "revision": next_revision}
        except Exception:
            cr.rollback()
            _logger.exception(
                "Could not reconcile Gateway activation revision for config %s",
                self.id,
            )
            return {"kind": "invalid"}
        finally:
            cr.close()

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
        max_reconciliation_attempts = 3
        try:
            for _attempt in range(max_reconciliation_attempts):
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
                redirect_message = _gateway_redirect_message(response, gateway_url)
                if redirect_message:
                    raise ValidationError(redirect_message)
                if response.status_code == 401:
                    raise ValidationError(_("Gateway activation synchronization was rejected because the API key is unauthorized."))
                body = response.json() if response.content else {}
                if not isinstance(body, dict):
                    raise ValidationError(_("Gateway activation synchronization returned an invalid response."))
                acknowledged_revision = body.get("revision")
                acknowledged_enabled = body.get("enabled")

                # A Gateway that already knows a newer revision is a normal
                # reconnect case, not a permanent failure. If it already has the
                # requested state, adopt its authoritative revision. Otherwise
                # advance Odoo's local fence past that revision and retry.
                reconciliation_reason = body.get("reason")
                has_remote_revision = (
                    isinstance(acknowledged_revision, int)
                    and acknowledged_revision >= 0
                    and isinstance(acknowledged_enabled, bool)
                )
                if response.status_code == 409:
                    current = body.get("current") if isinstance(body.get("current"), dict) else {}
                    acknowledged_revision = current.get("revision")
                    acknowledged_enabled = current.get("enabled")
                    has_remote_revision = (
                        isinstance(acknowledged_revision, int)
                        and acknowledged_revision >= 0
                        and isinstance(acknowledged_enabled, bool)
                    )
                    reconciliation_reason = "conflict"

                if response.status_code != 200 and response.status_code != 409:
                    message = body.get("error") if isinstance(body.get("error"), str) else False
                    raise ValidationError(
                        message or _("Gateway activation synchronization failed (HTTP %s).") % response.status_code
                    )

                if response.status_code == 200 and body.get("ok") is not True:
                    raise ValidationError(
                        body.get("error") if isinstance(body.get("error"), str) else _("Gateway activation synchronization failed.")
                    )

                if (
                    response.status_code == 200
                    and has_remote_revision
                    and acknowledged_revision == revision
                    and acknowledged_enabled is enabled
                ):
                    self._persist_enabled_sync_result(
                        dbname,
                        success=True,
                        revision=acknowledged_revision,
                        error=False,
                        expected_revision=revision,
                    )
                    return True

                if (
                    has_remote_revision
                    and acknowledged_revision >= revision
                    and reconciliation_reason in {"stale_revision", "already_current", "conflict"}
                ):
                    reconcile = self._reconcile_remote_enabled_revision(
                        expected_revision=revision,
                        remote_revision=acknowledged_revision,
                        remote_enabled=acknowledged_enabled is True,
                        desired_enabled=enabled,
                    )
                    if reconcile["kind"] == "converged":
                        return True
                    if reconcile["kind"] == "retry":
                        revision = int(reconcile["revision"])
                        continue
                    if reconcile["kind"] == "stale_local":
                        _logger.info(
                            "Gateway activation sync superseded by a newer local revision for config %s",
                            self.id,
                        )
                        return False

                raise ValidationError(
                    _("Gateway activation synchronization did not acknowledge the requested revision/state.")
                )

            raise ValidationError(
                _("Gateway activation synchronization could not converge after several fenced retries.")
            )
        except requests.RequestException as exc:
            message = str(_friendly_gateway_request_error(exc, gateway_url))[:4000]
            self._persist_enabled_sync_result(
                dbname,
                success=False,
                revision=None,
                error=message,
                expected_revision=revision,
            )
            _logger.warning("Gateway activation synchronization failed for config %s: %s", self.id, exc)
            return False
        except (ValidationError, ValueError) as exc:
            message = str(exc)[:4000]
            self._persist_enabled_sync_result(
                dbname,
                success=False,
                revision=None,
                error=message,
                expected_revision=revision,
            )
            _logger.warning("Gateway activation synchronization failed for config %s: %s", self.id, exc)
            return False

    def _persist_enabled_sync_result(
        self,
        dbname,
        *,
        success,
        revision,
        error,
        expected_revision=None,
    ):
        """Persist sync bookkeeping only while the recorded revision is still authoritative.

        Post-commit syncs can overlap. A result from an older revision must never
        erase the error/success state of a newer revision that is already pending
        or confirmed.
        """
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, api.SUPERUSER_ID, {})
            config = env["print_gateway.gateway_config"].browse(self.id).exists()
            if config:
                guard_revision = (
                    int(expected_revision)
                    if expected_revision is not None
                    else (int(revision) if revision is not None else None)
                )
                if guard_revision is not None:
                    cr.execute(
                        "SELECT enabled_sync_revision FROM %s WHERE id = %%s FOR UPDATE" % self._table,
                        [self.id],
                    )
                    row = cr.fetchone()
                    if not row or int(row[0] or 0) != guard_revision:
                        # A newer local revision owns the state now. Do not let
                        # this older worker overwrite its synchronization result.
                        cr.rollback()
                        return False

                values = {"last_enabled_sync_error": error or False}
                if success:
                    if revision is None:
                        cr.rollback()
                        return False
                    values.update({
                        "last_enabled_sync_revision": int(revision),
                        "last_enabled_sync_at": fields.Datetime.now(),
                        # The revision is confirmed: end its staleness window.
                        "pending_sync_revision": -1,
                        "pending_sync_started_at": False,
                    })
                config.with_context(skip_enabled_sync=True).write(values)
            cr.commit()
            return True
        except Exception:
            cr.rollback()
            _logger.exception("Could not persist Gateway activation sync result for config %s", self.id)
            return False
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
                # Never let a malformed URL/credential crash the write RPC.
                # Persist it as a visible sync error so the form shows
                # "Action needed" instead of an Oops RPC_ERROR dialog.
                try:
                    gateway_url = record._gateway_base(for_request=True)
                    api_key = record._gateway_api_key_plaintext()
                except (ValidationError, ValueError) as exc:
                    record._persist_enabled_sync_result(
                        self.env.cr.dbname,
                        success=False,
                        revision=None,
                        error=str(exc)[:4000],
                        expected_revision=int(record.enabled_sync_revision or 0),
                    )
                    continue
            record_id = record.id
            dbname = self.env.cr.dbname
            revision = int(record.enabled_sync_revision or 0)
            enabled = bool(record.enabled)
            try:
                pending_disable = record._pending_disable_credentials()
            except (ValidationError, ValueError):
                pending_disable = None
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
        key_removal_shutdowns = {}
        key_removal_unconfirmed = {}
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
                if remote_may_still_be_enabled and record.last_test_status == "revoked":
                    # The old credential is already known to be unusable. It
                    # cannot safely be used to mutate the Gateway, so removing
                    # it must not create an endless retry fence. Keep the
                    # activation revision unacknowledged so the UI reports
                    # that the remote state still needs a valid credential.
                    key_removal_unconfirmed[record.id] = True
                    continue
                try:
                    credentials = (
                        record._gateway_base(for_request=True),
                        record._gateway_api_key_plaintext(),
                    )
                    pre_sync_credentials[record.id] = credentials
                    if remote_may_still_be_enabled:
                        key_removal_shutdowns[record.id] = credentials
                except (ValidationError, ValueError, CredentialKeyUnavailable, CredentialDecryptError) as exc:
                    if remote_may_still_be_enabled:
                        raise ValidationError(
                            _("The existing Gateway API key cannot be decrypted, so Odoo will not remove it while the Gateway may still be active.")
                        ) from exc
        url_migrations = {}

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
                if key_removed and before_enabled.get(record.id) and not enabled_changed:
                    raise ValidationError(
                        _("Disable Gateway printing before removing its installation API key.")
                    )
                if url_changed or enabled_changed:
                    new_revision = before_revision[record.id] + 1
                    technical_values = {
                        "enabled_sync_revision": new_revision,
                        "last_enabled_sync_error": False,
                        # Bound the staleness fence to THIS revision: stamped
                        # exactly when the revision starts awaiting the
                        # Gateway, cleared when an outcome is recorded.
                        "pending_sync_revision": new_revision,
                        "pending_sync_started_at": fields.Datetime.now(),
                    }
                    if api_key_changed:
                        technical_values.update({
                            "last_test_status": "draft",
                            "last_test_at": False,
                            "last_test_error": False,
                        })
                    migration = url_migrations.get(record.id)
                    pending_disable = migration if url_changed else (key_removal_shutdowns.get(record.id) if key_removed else None)
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
                        if key_removed and key_removal_unconfirmed.get(record.id):
                            technical_values["last_enabled_sync_error"] = _(
                                "The previous Gateway API key was already revoked, so Odoo could not confirm the remote Gateway was disabled. Add a new key and test the connection to finish synchronization."
                            )
                    record.sudo().write(technical_values)
                    # The technical revision was written through a separate sudoed
                    # recordset/environment. The original recordset can still hold
                    # the pre-write value in Odoo's ORM cache; reading it immediately
                    # would queue the post-commit sync with a stale revision.
                    # Invalidate only the fields changed by that sudo write so the
                    # queue reads the durable revision/state that was just persisted.
                    record.invalidate_recordset([
                        "enabled_sync_revision",
                        "last_enabled_sync_revision",
                        "last_enabled_sync_error",
                        "pending_disable_gateway_url",
                        "pending_disable_gateway_api_key",
                        "pending_disable_revision",
                        "gateway_sync_state",
                        "gateway_sync_message",
                    ])
                    # The technical write happens through a separate sudoed
                    # environment. In Odoo 19, invalidating the cache alone is
                    # not enough when stored computed fields depend on values
                    # changed outside the original recordset: notify the ORM
                    # that the dependencies changed so gateway_sync_state and
                    # gateway_sync_message are recomputed in this transaction.
                    record.modified(["enabled_sync_revision", "last_enabled_sync_error"])
                elif "gateway_api_key" in vals:
                    # Rotating or restoring a credential must start a fresh
                    # fenced reconciliation. Reusing the previous activation
                    # revision can leave the UI stuck on Action needed when
                    # the Gateway never observed the key transition.
                    record.sudo().write({
                        "enabled_sync_revision": before_revision[record.id] + 1,
                        "last_enabled_sync_error": False,
                        "pending_sync_revision": before_revision[record.id] + 1,
                        "pending_sync_started_at": fields.Datetime.now(),
                        "last_test_status": "draft",
                        "last_test_at": False,
                        "last_test_error": False,
                    })
                    record.invalidate_recordset([
                        "enabled_sync_revision",
                        "last_enabled_sync_revision",
                        "last_enabled_sync_error",
                        "gateway_sync_state",
                        "gateway_sync_message",
                    ])
                    record.modified([
                        "enabled_sync_revision",
                        "last_enabled_sync_error",
                    ])
            self._queue_enabled_state_sync(pre_sync_credentials)

        return result

    @api.model_create_multi
    def create(self, vals_list):
        self._check_admin()
        normalized = []
        for original in vals_list:
            vals = dict(original)
            vals.setdefault("company_id", (self.env.company.parent_id or self.env.company).id)
            # The initial revision starts awaiting the Gateway immediately.
            vals["pending_sync_revision"] = int(vals.get("enabled_sync_revision") or 0)
            vals["pending_sync_started_at"] = fields.Datetime.now()
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

    def _disable_gateway_for_unlink(self, gateway_url, api_key, revision):
        """Best-effort remote shutdown used before deleting the Odoo config."""
        revision = max(0, int(revision))
        url = "%s/api/odoo/configuration" % gateway_url
        headers = {
            "Authorization": "Bearer %s" % api_key,
            "Accept": "application/json",
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
            "X-Odoo-Database": self.env.cr.dbname,
        }

        def send(target_revision):
            response = requests.patch(
                url,
                headers=headers,
                json={"enabled": False, "revision": target_revision},
                timeout=10,
                allow_redirects=False,
            )
            body = response.json() if response.content else {}
            return response, body

        try:
            response, body = send(revision)
            redirect_message = _gateway_redirect_message(response, gateway_url)
            if redirect_message:
                _logger.warning(
                    "Gateway deletion shutdown redirected for config %s: %s",
                    self.id,
                    redirect_message,
                )
                return False
            if response.status_code == 401:
                raise ValidationError(
                    _("The Gateway rejected the deletion shutdown because the stored API key is unauthorized.")
                )

            if (
                response.status_code == 200
                and isinstance(body, dict)
                and body.get("ok") is True
                and body.get("enabled") is False
            ):
                acknowledged = body.get("revision")
                if isinstance(acknowledged, int):
                    return True

            # A race may have advanced the Gateway revision after the Odoo
            # record was last synchronized. If the Gateway reports its current
            # revision and is still enabled, issue one fenced follow-up update.
            if (
                response.status_code == 200
                and isinstance(body, dict)
                and body.get("reason") == "stale_revision"
                and body.get("enabled") is True
                and isinstance(body.get("revision"), int)
            ):
                next_revision = body["revision"] + 1
                if next_revision <= 2_147_483_647:
                    response, body = send(next_revision)
                    if response.status_code == 401:
                        raise ValidationError(
                            _("The Gateway rejected the deletion shutdown because the API key is unauthorized.")
                        )
                    if (
                        response.status_code == 200
                        and isinstance(body, dict)
                        and body.get("ok") is True
                        and body.get("enabled") is False
                        and isinstance(body.get("revision"), int)
                    ):
                        return True

            message = body.get("error") if isinstance(body, dict) else False
            _logger.warning(
                "Gateway deletion shutdown was not confirmed for config %s (HTTP %s): %s",
                self.id,
                response.status_code,
                message or body,
            )
        except (requests.RequestException, ValueError, ValidationError) as exc:
            _logger.warning(
                "Gateway deletion shutdown failed for config %s: %s",
                self.id,
                exc,
            )
        return False

    def unlink(self):
        self._check_admin()
        # Best-effort disable sync before deletion so the Gateway does not
        # keep a stale enabled state after the Odoo record disappears.
        # Deletion itself must not be blocked by Gateway reachability.
        # Skip external calls during Odoo test mode to keep tests fast and deterministic.
        in_test = False
        try:
            in_test = bool(self.env.registry.in_test_mode() or self.env.context.get("test_mode") or self.env.context.get("test_queue_job_no_delay"))
        except Exception:
            in_test = False
        if not in_test:
            for record in self:
                try:
                    if not record.gateway_url:
                        continue
                    # Skip example/test domains used in Odoo test suites.
                    # Still allow real localhost / LAN URLs, but skip obvious
                    # test placeholders to avoid 5s timeouts in CI.
                    url_lower = (record.gateway_url or "").lower()
                    if "example.com" in url_lower:
                        continue
                    if "test" in url_lower and "localhost" not in url_lower and "127.0.0.1" not in url_lower:
                        continue
                    if record.pending_disable_gateway_url and record.pending_disable_gateway_api_key:
                        try:
                            old_key = record._gateway_api_key_plaintext_from_value(
                                record.pending_disable_gateway_api_key
                            )
                            if old_key:
                                requests.patch(
                                    "%s/api/odoo/configuration" % record.pending_disable_gateway_url.rstrip("/"),
                                    headers={
                                        "Authorization": "Bearer %s" % old_key,
                                        "Accept": "application/json",
                                        "Cache-Control": "no-store",
                                        "Content-Type": "application/json",
                                        "X-Odoo-Database": self.env.cr.dbname,
                                    },
                                    json={"enabled": False, "revision": int(record.pending_disable_revision or 0)},
                                    timeout=2,
                                    allow_redirects=False,
                                )
                        except Exception:
                            _logger.debug(
                                "Could not disable previous Gateway endpoint during unlink for config %s",
                                record.id,
                                exc_info=True,
                            )
                    if not record.gateway_api_key:
                        continue
                    try:
                        gateway_url = record._gateway_base(for_request=True)
                        api_key = record._gateway_api_key_plaintext()
                    except Exception:
                        _logger.debug(
                            "Could not decrypt Gateway credential during unlink for config %s",
                            record.id,
                            exc_info=True,
                        )
                        continue
                    new_revision = int(record.enabled_sync_revision or 0) + 1
                    try:
                        record._disable_gateway_for_unlink(gateway_url, api_key, new_revision)
                    except Exception:
                        _logger.debug(
                            "Gateway disable during unlink failed for config %s",
                            record.id,
                            exc_info=True,
                        )
                except Exception:
                    _logger.debug(
                        "Unexpected error during unlink sync for config %s",
                        record.id,
                        exc_info=True,
                    )
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
            skipped_same_endpoint_revision = None
            if (
                config.pending_disable_gateway_url
                and config.pending_disable_gateway_api_key
                and int(config.pending_disable_revision or -1) >= 0
            ):
                try:
                    pending_disable = config._pending_disable_credentials()
                    if not pending_disable:
                        continue
                    old_url, old_api_key, old_revision = pending_disable
                    if config.gateway_api_key and _same_gateway_endpoint(old_url, config.gateway_url):
                        # Same-endpoint fence: the authoritative fenced PATCH
                        # in the activation block below supersedes the
                        # redundant disable round-trip — skip the shutdown and
                        # let the current state converge (fence clears after
                        # the new endpoint confirms, see below).
                        skipped_same_endpoint_revision = old_revision
                        pass
                    else:
                        shutdown_api_key = old_api_key
                        if (
                            config.gateway_api_key
                            and old_url == config.gateway_url
                        ):
                            shutdown_api_key = config._gateway_api_key_plaintext()
                        if not config._sync_pending_gateway_disable(
                            gateway_url=old_url,
                            api_key=shutdown_api_key,
                            revision=old_revision,
                        ):
                            continue
                        if not config.gateway_api_key:
                            config._complete_gateway_migration(old_revision)
                            continue
                except (ValidationError, requests.RequestException, ValueError) as exc:
                    config._persist_gateway_migration_result(success=False, error=str(exc))
                    _logger.warning(
                        "Gateway endpoint shutdown retry failed for config %s: %s",
                        config.id,
                        exc,
                    )
                    continue
                except Exception:  # noqa: BLE001 - a crashing config must surface, never hang pending silently
                    config._persist_gateway_migration_result(
                        success=False,
                        error="CRON_ERROR: unexpected shutdown reconciliation failure (see Odoo server log)",
                    )
                    _logger.exception(
                        "Gateway shutdown cron crashed for config %s", config.id
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
                    ):
                        if config.pending_disable_gateway_url:
                            config._complete_gateway_migration(revision)
                        if skipped_same_endpoint_revision is not None:
                            config._complete_gateway_migration(skipped_same_endpoint_revision)
                except (ValidationError, requests.RequestException, ValueError) as exc:
                    message = str(exc)[:4000]
                    config._persist_enabled_sync_result(
                        self.env.cr.dbname,
                        success=False,
                        revision=None,
                        error=message,
                        expected_revision=revision,
                    )
                    _logger.warning(
                        "Gateway activation reconciliation failed for config %s: %s",
                        config.id,
                        exc,
                    )
                except Exception:  # noqa: BLE001 - a crashing config must surface as "attention", never spin forever
                    config._persist_enabled_sync_result(
                        self.env.cr.dbname,
                        success=False,
                        revision=None,
                        error="CRON_ERROR: unexpected activation reconciliation failure (see Odoo server log)",
                        expected_revision=revision,
                    )
                    _logger.exception(
                        "Gateway activation cron crashed for config %s", config.id
                    )
        return True

    def action_retry_enabled_sync(self):
        """Run the pending activation synchronization immediately.

        The post-commit hook and the retry cron already converge automatically;
        this is the operator's explicit recovery path when the staleness fence
        has escalated the form to "attention". The shared runner persists the
        outcome (success or error) on a fresh cursor either way.
        """
        self.ensure_one()
        self._check_admin()
        dbname = self.env.cr.dbname
        if not self.gateway_api_key and not self.pending_disable_gateway_url:
            raise ValidationError(_("Add an installation API key before synchronizing."))
        # Never replay a revision the fence has already moved past: read the
        # desired revision/state fresh at trigger time, exactly like the retry
        # cron does. If a concurrent write bumps the revision between this
        # read and the PATCH, the Gateway-side reconciliation cursor
        # (_reconcile_remote_enabled_revision) re-locks the row, detects the
        # mismatch, and aborts this older attempt so the newer local
        # transaction stays authoritative. Like every caller of the shared
        # runner, no manual commit happens inside this RPC transaction;
        # outcome persistence uses its own dedicated cursor.
        self.invalidate_recordset(["enabled_sync_revision", "enabled"])
        revision = int(self.enabled_sync_revision or 0)
        enabled = bool(self.enabled)
        gateway_url = None
        api_key = None
        if self.gateway_api_key:
            try:
                gateway_url = self._gateway_base(for_request=True)
                api_key = self._gateway_api_key_plaintext()
            except (ValidationError, ValueError, CredentialKeyUnavailable, CredentialDecryptError) as exc:
                self._persist_enabled_sync_result(
                    dbname,
                    success=False,
                    revision=None,
                    error=str(exc)[:4000],
                    expected_revision=revision,
                )
                return {"type": "ir.actions.client", "tag": "reload"}
        try:
            pending_disable = self._pending_disable_credentials()
        except (ValidationError, ValueError, CredentialKeyUnavailable, CredentialDecryptError):
            pending_disable = None
        self._run_postcommit_enabled_sync(
            gateway_url=gateway_url,
            api_key=api_key,
            dbname=dbname,
            revision=revision,
            enabled=enabled,
            pending_disable=pending_disable,
        )
        self.invalidate_recordset([
            "gateway_sync_state",
            "gateway_sync_message",
            "last_enabled_sync_revision",
            "last_enabled_sync_error",
        ])
        return {"type": "ir.actions.client", "tag": "reload"}

    def _write_test_result_if_current(self, expected_revision, values):
        """Persist a connection-test result on an independent cursor.

        Test Connection can overlap a concurrent configuration save or another
        test. Keep the RPC transaction out of this write path so a PostgreSQL
        serialization conflict cannot abort the whole Odoo request and surface
        as RPC_ERROR. The same revision fence still decides whether the result
        is authoritative.
        """
        self.ensure_one()
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, api.SUPERUSER_ID, {})
            config = env["print_gateway.gateway_config"].browse(self.id).exists()
            if not config:
                cr.rollback()
                return False

            cr.execute(
                "SELECT enabled_sync_revision FROM %s WHERE id = %%s FOR UPDATE NOWAIT" % self._table,
                [self.id],
            )
            row = cr.fetchone()
            if not row or int(row[0] or 0) != int(expected_revision):
                cr.rollback()
                return False

            config.with_context(skip_enabled_sync=True).write(values)
            cr.commit()
            self.invalidate_recordset([
                "enabled",
                "enabled_sync_revision",
                "last_enabled_sync_revision",
                "last_enabled_sync_error",
                "last_test_at",
                "last_test_status",
                "last_test_error",
            ])
            return True
        except Exception:
            cr.rollback()
            _logger.warning(
                "Could not persist Gateway connection-test result for config %s; "
                "the result may have been superseded by a concurrent update",
                self.id,
                exc_info=True,
            )
            return False
        finally:
            cr.close()

    def action_test_connection(self):
        self.ensure_one()
        self._check_admin()
        # A connection test is bound to the activation revision it started
        # against. If a newer save/revision lands while the network request is
        # in flight, this request becomes observationally stale and must not
        # overwrite the newer credential/activation state.
        self.invalidate_recordset(["enabled_sync_revision", "enabled"])
        expected_revision = int(self.enabled_sync_revision or 0)
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
            redirect_message = _gateway_redirect_message(response, self.gateway_url)
            if redirect_message:
                if not self._write_test_result_if_current(expected_revision, {
                    "last_test_at": fields.Datetime.now(),
                    "last_test_status": "failed",
                    "last_test_error": redirect_message,
                }):
                    return {"type": "ir.actions.client", "tag": "reload"}
                return {
                    "type": "ir.actions.client",
                    "tag": "display_notification",
                    "params": {"title": _("Gateway Connection"), "message": redirect_message, "type": "warning", "sticky": True},
                }
            if response.status_code == 401:
                message = _("The Gateway rejected the API key. Replace the key and test the connection again.")
                if not self._write_test_result_if_current(expected_revision, {
                    "last_test_at": fields.Datetime.now(),
                    "last_test_status": "revoked",
                    "last_test_error": message,
                    "enabled": False,
                }):
                    return {"type": "ir.actions.client", "tag": "reload"}
                return {
                    "type": "ir.actions.client",
                    "tag": "display_notification",
                    "params": {"title": _("Gateway Connection"), "message": message, "type": "warning", "sticky": True},
                }
            if response.status_code == 403:
                body = response.json() if response.content else {}
                message = (
                    body.get("error")
                    if isinstance(body, dict) and body.get("error")
                    else _("The Gateway workspace is not available for printing.")
                )
                if not self._write_test_result_if_current(expected_revision, {
                    "last_test_at": fields.Datetime.now(),
                    "last_test_status": "failed",
                    "last_test_error": message,
                }):
                    return {"type": "ir.actions.client", "tag": "reload"}
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

            # Re-read the persisted identity and revision after the network
            # health check. A newer key/activation save may have committed while
            # the request was in flight; the older test must not send its stale
            # credential or desired state to the Gateway.
            self.invalidate_recordset([
                "gateway_url",
                "gateway_api_key",
                "enabled",
                "enabled_sync_revision",
            ])
            current_revision = int(self.enabled_sync_revision or 0)
            if current_revision != expected_revision:
                return {"type": "ir.actions.client", "tag": "reload"}

            # A connection test is an explicit operator action, so finish the
            # activation reconciliation in this request instead of leaving the
            # form displaying a stale "Syncing" state until the next manual
            # refresh. The same fenced revision/idempotent Gateway endpoint is
            # used by the normal post-commit sync path.
            sync_succeeded = self._sync_enabled_state_to_gateway(
                self._gateway_base(for_request=True),
                self._gateway_api_key_plaintext(),
                self.env.cr.dbname,
                current_revision,
                bool(self.enabled),
            )
            if not sync_succeeded:
                self.invalidate_recordset([
                    "gateway_sync_state",
                    "gateway_sync_message",
                    "last_enabled_sync_error",
                    "last_enabled_sync_revision",
                ])
                return {
                    "type": "ir.actions.client",
                    "tag": "reload",
                }

            # _sync_enabled_state_to_gateway persists the authoritative state
            # through a fresh cursor. Record the connection-test success only
            # when the same revision is still current; an overlapping newer
            # save must retain ownership of the record state.
            self.invalidate_recordset([
                "enabled_sync_revision",
                "last_enabled_sync_revision",
                "last_enabled_sync_error",
            ])
            current_revision = int(self.enabled_sync_revision or 0)
            if not self._write_test_result_if_current(current_revision, {
                "last_test_at": fields.Datetime.now(),
                "last_test_status": "success",
                "last_test_error": False,
            }):
                return {"type": "ir.actions.client", "tag": "reload"}

            # The save hook intentionally ignores the server "reload" action
            # and performs a record-level model.load, so the Gateway status
            # becomes Active immediately after the persisted sync result lands.
            return {
                "type": "ir.actions.client",
                "tag": "reload",
            }
        except ValidationError as exc:
            if not self._write_test_result_if_current(expected_revision, {
                "last_test_at": fields.Datetime.now(),
                "last_test_status": "failed",
                "last_test_error": str(exc)[:4000],
            }):
                return {"type": "ir.actions.client", "tag": "reload"}
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {"title": _("Gateway Connection"), "message": str(exc), "type": "danger", "sticky": True},
            }
        except requests.RequestException as exc:
            try:
                failed_url = self._gateway_base(for_request=False)
            except ValidationError:
                failed_url = self.gateway_url
            msg = _friendly_gateway_request_error(exc, failed_url)
            if not self._write_test_result_if_current(expected_revision, {
                "last_test_at": fields.Datetime.now(),
                "last_test_status": "failed",
                "last_test_error": msg,
            }):
                return {"type": "ir.actions.client", "tag": "reload"}
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {"title": _("Gateway Connection"), "message": msg, "type": "danger", "sticky": True},
            }
        except ValueError as exc:
            msg = _("Gateway returned an invalid health response.")
            if not self._write_test_result_if_current(expected_revision, {
                "last_test_at": fields.Datetime.now(),
                "last_test_status": "failed",
                "last_test_error": msg,
            }):
                return {"type": "ir.actions.client", "tag": "reload"}
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {"title": _("Gateway Connection"), "message": msg, "type": "danger", "sticky": True},
            }


    def action_reset_stale_sync_state(self):
        """Recover from a removed/reconfigured Gateway without an RPC error.

        Clears a stuck old-endpoint shutdown fence and unconfirmed revision so
        a fresh Gateway URL + API key can synchronize from revision 0. Only
        allowed when the operator explicitly requests recovery; never called
        automatically.
        """
        self.ensure_one()
        self._check_admin()
        self.sudo().with_context(skip_enabled_sync=True).write({
            "pending_disable_gateway_url": False,
            "pending_disable_gateway_api_key": False,
            "pending_disable_revision": -1,
            "last_gateway_migration_sync_error": False,
            "last_enabled_sync_error": False,
            "pending_sync_revision": int(self.enabled_sync_revision or 0),
            "pending_sync_started_at": fields.Datetime.now(),
        })
        self.invalidate_recordset([
            "gateway_sync_state",
            "gateway_sync_message",
            "last_enabled_sync_error",
            "pending_disable_gateway_url",
            "pending_disable_gateway_api_key",
            "pending_disable_revision",
        ])
        return {"type": "ir.actions.client", "tag": "reload"}

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
            "tag": "reload",
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
                raise ValidationError(_("Gateway authentication failed (HTTP %s). Check the Gateway API key and that the workspace has an active subscription.") % response.status_code)
            redirect_message = _gateway_redirect_message(response, config.gateway_url)
            if redirect_message:
                raise ValidationError(redirect_message)
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
            raise ValidationError(str(_friendly_gateway_request_error(exc, config.gateway_url))) from exc

