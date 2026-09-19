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

    def _gateway_api_key_plaintext(self):
        self.ensure_one()
        if not self.gateway_api_key:
            raise ValidationError(_("Gateway API key is not configured."))
        try:
            protected = self._protected_gateway_api_key(self.gateway_api_key)
            if protected != self.gateway_api_key:
                self.sudo().write({"gateway_api_key": protected})
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

    def _sync_enabled_state_to_gateway(self, expected_revision=None, expected_enabled=None):
        """Push the Odoo activation checkbox to the Gateway after commit."""
        self.ensure_one()
        revision = int(
            self.enabled_sync_revision if expected_revision is None else expected_revision
        )
        enabled = bool(self.enabled if expected_enabled is None else expected_enabled)
        if not self.gateway_api_key:
            return False
        try:
            response = requests.patch(
                "%s/api/odoo/configuration" % self._gateway_base(for_request=True),
                headers={**self._gateway_headers(), "Content-Type": "application/json"},
                json={"enabled": enabled, "revision": revision},
                timeout=(5, 10),
                allow_redirects=False,
            )
            body = response.json() if response.content else {}
            if response.status_code != 200 or not isinstance(body, dict) or body.get("ok") is not True:
                message = body.get("error") if isinstance(body, dict) else False
                raise ValidationError(
                    message or _("Gateway activation synchronization failed (HTTP %s).") % response.status_code
                )
            acknowledged_revision = body.get("revision")
            if not isinstance(acknowledged_revision, int) or acknowledged_revision < -1:
                raise ValidationError(_("Gateway activation synchronization returned an invalid revision."))
            self.sudo().write({
                "last_enabled_sync_revision": acknowledged_revision,
                "last_enabled_sync_at": fields.Datetime.now(),
                "last_enabled_sync_error": False,
            })
            return True
        except (ValidationError, requests.RequestException, ValueError) as exc:
            message = str(exc)[:4000]
            try:
                self.sudo().write({"last_enabled_sync_error": message})
            except Exception:
                _logger.warning("Could not persist Gateway activation sync error for config %s", self.id)
            _logger.warning("Gateway activation synchronization failed for config %s: %s", self.id, exc)
            return False

    def _queue_enabled_state_sync(self):
        for record in self:
            if not record.gateway_api_key:
                continue
            record_id = record.id
            revision = int(record.enabled_sync_revision or 0)
            enabled = bool(record.enabled)
            self.env.cr.postcommit.add(
                lambda record_id=record_id, revision=revision, enabled=enabled:
                    self.browse(record_id)._sync_enabled_state_to_gateway(
                        expected_revision=revision,
                        expected_enabled=enabled,
                    )
            )

    def _check_admin(self):
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only Odoo system administrators can change Gateway configuration."))

    def write(self, vals):
        sync_fields = {"enabled", "gateway_url", "gateway_api_key"}
        if set(vals).intersection({"gateway_url", "gateway_api_key", "enabled", "company_id", "runtime_agent_id"}):
            self._check_admin()
        vals = dict(vals)
        before_enabled = {record.id: bool(record.enabled) for record in self}
        if "gateway_api_key" in vals and vals["gateway_api_key"]:
            try:
                vals["gateway_api_key"] = self._protected_gateway_api_key(vals["gateway_api_key"])
            except (CredentialKeyUnavailable, CredentialDecryptError, ValueError) as exc:
                raise ValidationError(
                    _("Gateway credential protection is unavailable. Configure the deployment-managed credential encryption key before saving an API key.")
                ) from exc
        result = super().write(vals)
        if sync_fields.intersection(vals):
            for record in self:
                if "enabled" in vals and before_enabled.get(record.id) != bool(record.enabled):
                    record.sudo().write({
                        "enabled_sync_revision": int(record.enabled_sync_revision or 0) + 1,
                        "last_enabled_sync_error": False,
                    })
            self._queue_enabled_state_sync()
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
    def cron_sync_enabled_state(self):
        """Retry activation-state replication for configurations not yet acknowledged."""
        configs = self.sudo().search([
            ("gateway_url", "!=", False),
            ("gateway_api_key", "!=", False),
        ])
        for config in configs:
            if (
                int(config.last_enabled_sync_revision or -1) != int(config.enabled_sync_revision or 0)
                or bool(config.last_enabled_sync_error)
            ):
                config._sync_enabled_state_to_gateway()
        return True

    def action_test_connection(self):
        self.ensure_one()
        self._check_admin()
        try:
            response = requests.get(
                "%s/api/odoo/health" % self._gateway_base(for_request=True),
                headers=self._gateway_headers(),
                timeout=(5, 10),
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
                timeout=(5, 10),
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


