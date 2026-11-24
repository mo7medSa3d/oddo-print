# -*- coding: utf-8 -*-
"""Minimal Direct Odoo Print Service configuration and Cloud licence refresh.

The Odoo module's technical model name is retained so existing installations
upgrade in place. It no longer stores or synchronizes a remote print Gateway.
"""

import base64
import collections
import datetime
import functools
import json
import logging
import threading

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError

_logger = logging.getLogger(__name__)

# Optional build-time pinned Ed25519 public key (base64/PEM). When set, it takes
# precedence over ir.config_parameter 'print_gateway.license_public_key_b64'.
PINNED_LICENSE_PUBLIC_KEY_B64 = "V7Rf2YzctJpIe65VtCwvxWYe0IS57txYbGEhCHmAwa0="


def _resolve_license_public_key(icp):
    return PINNED_LICENSE_PUBLIC_KEY_B64.strip() or (icp.get_param("print_gateway.license_public_key_b64") or "").strip()


def _parse_iso_utc(value):
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(datetime.timezone.utc)


def _extract_bundle_rev(bundle):
    if not isinstance(bundle, dict):
        return 0
    payload = bundle.get("payload")
    if not isinstance(payload, dict):
        return 0
    rev = payload.get("rev", 0)
    if isinstance(rev, bool) or not isinstance(rev, int) or rev < 0:
        return None
    return rev


def _canonical_claims_bytes(claims):
    """Canonical sorted compact JSON matching Node license-signer.ts and Go license.go."""
    return json.dumps(claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


# Bounded cache of verified (pub_key_b64, sig_str, canonical_claims_bytes) tuples.
# Only valid signatures are cached so invalid-signature floods cannot evict the active key.
_VERIFIED_SIG_CACHE_LOCK = threading.Lock()
_VERIFIED_SIG_CACHE = collections.OrderedDict()
_VERIFIED_SIG_CACHE_MAX = 16


@functools.lru_cache(maxsize=8)
def _load_ed25519_public_key_cached(raw_text):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    if raw_text.startswith("-----BEGIN"):
        key = serialization.load_pem_public_key(raw_text.encode("utf-8"))
        return key if isinstance(key, Ed25519PublicKey) else None
    padded = raw_text + "=" * (-len(raw_text) % 4)
    try:
        key_bytes = base64.b64decode(padded, validate=True)
    except Exception:
        key_bytes = base64.urlsafe_b64decode(padded)
    if len(key_bytes) == 32:
        return Ed25519PublicKey.from_public_bytes(key_bytes)
    key = serialization.load_der_public_key(key_bytes)
    return key if isinstance(key, Ed25519PublicKey) else None


def _load_ed25519_public_key(pub_key_b64):
    raw_text = (pub_key_b64 or "").strip()
    if not raw_text:
        return None
    return _load_ed25519_public_key_cached(raw_text)


def _verify_bundle_signature(bundle, pub_key_b64):
    """Strict fail-closed Ed25519 signature verification."""
    clean_pub = (pub_key_b64 or "").strip()
    if not clean_pub:
        return False, "public_key_not_configured"
    try:
        from cryptography.exceptions import InvalidSignature
    except ImportError:
        return False, "cryptography_required"

    sig_str = bundle.get("signature") if isinstance(bundle, dict) else None
    if not isinstance(sig_str, str):
        return False, "invalid_signature"
    clean_sig = sig_str.strip()
    if not clean_sig:
        return False, "invalid_signature"

    canonical_bytes = _canonical_claims_bytes(bundle["payload"])
    cache_key = (clean_pub, clean_sig, canonical_bytes)
    with _VERIFIED_SIG_CACHE_LOCK:
        if cache_key in _VERIFIED_SIG_CACHE:
            _VERIFIED_SIG_CACHE.move_to_end(cache_key)
            return True, "ok"

    try:
        pub_key = _load_ed25519_public_key(clean_pub)
    except Exception:
        return False, "invalid_public_key"
    if pub_key is None:
        return False, "invalid_public_key"
    try:
        padded_sig = clean_sig + "=" * (-len(clean_sig) % 4)
        sig_bytes = base64.urlsafe_b64decode(padded_sig)
        pub_key.verify(sig_bytes, canonical_bytes)
    except InvalidSignature:
        return False, "invalid_signature"
    except Exception:
        return False, "invalid_signature"

    with _VERIFIED_SIG_CACHE_LOCK:
        _VERIFIED_SIG_CACHE[cache_key] = True
        _VERIFIED_SIG_CACHE.move_to_end(cache_key)
        if len(_VERIFIED_SIG_CACHE) > _VERIFIED_SIG_CACHE_MAX:
            _VERIFIED_SIG_CACHE.popitem(last=False)
    return True, "ok"


def _validate_license_bundle(
    bundle,
    expected_db_uuid="",
    pub_key_b64="",
    check_expiry=True,
    now=None,
    require_db_uuid=True,
):
    """Strictly validate structure, limits, DB UUID binding, Ed25519 signature, status, and grace period."""
    if not isinstance(bundle, dict):
        return False, "invalid_bundle"
    claims = bundle.get("payload")
    signature = bundle.get("signature")
    if not isinstance(claims, dict) or not isinstance(signature, str) or not signature.strip():
        return False, "invalid_bundle"
    version = claims.get("version")
    if isinstance(version, bool) or version not in (1, 2) or not str(claims.get("license_id") or "").strip():
        return False, "invalid_bundle"
    if _extract_bundle_rev(bundle) is None:
        return False, "invalid_rev"

    max_agents = claims.get("max_agents")
    max_printers = claims.get("max_printers")
    if (
        isinstance(max_agents, bool)
        or not isinstance(max_agents, int)
        or max_agents < 0
        or isinstance(max_printers, bool)
        or not isinstance(max_printers, int)
        or max_printers < 0
    ):
        return False, "invalid_limits"

    bundle_db_uuid = str(claims.get("odoo_db_uuid") or "").strip()
    expected_clean = str(expected_db_uuid or "").strip()
    if require_db_uuid:
        if not expected_clean or not bundle_db_uuid or bundle_db_uuid != expected_clean:
            return False, "db_uuid_mismatch"
    elif expected_clean and bundle_db_uuid != expected_clean:
        return False, "db_uuid_mismatch"

    sig_ok, sig_reason = _verify_bundle_signature(bundle, pub_key_b64)
    if not sig_ok:
        return False, sig_reason

    status = str(claims.get("status") or "active").strip().lower()
    if status == "revoked":
        return False, "license_revoked"
    if status != "active":
        return False, "invalid_status"

    if check_expiry:
        expires_dt = _parse_iso_utc(claims.get("expires_at"))
        grace_dt = _parse_iso_utc(claims.get("grace_until"))
        if expires_dt is None or grace_dt is None or grace_dt < expires_dt:
            return False, "invalid_timestamps"
        now_utc = now or datetime.datetime.now(datetime.timezone.utc)
        if now_utc.tzinfo is None:
            now_utc = now_utc.replace(tzinfo=datetime.timezone.utc)
        if now_utc > grace_dt:
            return False, "license_expired"

    return True, "ok"


def verify_stored_license_bundle(icp, now=None):
    """Strictly verify the persisted signed license bundle in ir.config_parameter.

    Returns ``(ok, reason, bundle_dict)``. Fails closed when no bundle or public
    key is configured, when cryptography is unavailable, or when DB UUID mismatches.
    """
    raw = (icp.get_param("print_gateway.signed_license_bundle") or "").strip()
    if not raw:
        return False, "license_required", None
    try:
        bundle = json.loads(raw)
    except (TypeError, ValueError):
        return False, "invalid_bundle", None
    if not isinstance(bundle, dict):
        return False, "invalid_bundle", None

    expected_db_uuid = (icp.get_param("database.uuid") or "").strip()
    pub_key_b64 = _resolve_license_public_key(icp)
    ok, reason = _validate_license_bundle(
        bundle,
        expected_db_uuid=expected_db_uuid,
        pub_key_b64=pub_key_b64,
        check_expiry=True,
        now=now,
        require_db_uuid=True,
    )
    return ok, reason, bundle


def check_license_limits(icp, active_agents=None, active_printers=None, now=None):
    """Verify the stored license and enforce max_agents / max_printers entitlements."""
    ok, reason, bundle = verify_stored_license_bundle(icp, now=now)
    if not ok:
        return False, reason, bundle
    payload = bundle.get("payload") or {}
    if active_agents is not None:
        max_agents = payload.get("max_agents", 0)
        if max_agents > 0 and active_agents > max_agents:
            return False, "max_agents_exceeded", bundle
    if active_printers is not None:
        max_printers = payload.get("max_printers", 0)
        if max_printers > 0 and active_printers > max_printers:
            return False, "max_printers_exceeded", bundle
    return True, "ok", bundle


class PrintGatewayConfig(models.Model):
    _name = "print_gateway.gateway_config"
    _description = "Direct Odoo Print Service Configuration"
    _order = "company_id"
    _rec_name = "company_id"

    company_id = fields.Many2one(
        "res.company",
        string="Company",
        required=True,
        default=lambda self: self.env.company.parent_id or self.env.company,
        domain="[('parent_id', '=', False)]",
        ondelete="restrict",
        index=True,
    )
    enabled = fields.Boolean(string="Direct Printing Enabled", default=False)
    license_server_url = fields.Char(
        string="License Gateway URL",
        compute="_compute_license_config",
        inverse="_inverse_license_server_url",
        help="Base URL of your Yaseir License Gateway (e.g. https://license.example.com).",
    )
    license_api_key = fields.Char(
        string="Odoo API / License Key",
        compute="_compute_license_config",
        inverse="_inverse_license_api_key",
        groups="base.group_system",
        help="Paste the Odoo API key created in the Gateway /api-keys page.",
    )
    license_public_key_b64 = fields.Char(
        string="Ed25519 Public Key (Base64)",
        compute="_compute_license_config",
        inverse="_inverse_license_public_key_b64",
        help="Optional if pinned in code; otherwise paste the Gateway Ed25519 public key.",
    )
    odoo_db_uuid = fields.Char(
        string="Odoo Database UUID",
        compute="_compute_license_status",
        readonly=True,
    )
    license_status = fields.Char(
        string="License Status",
        compute="_compute_license_status",
        readonly=True,
    )
    license_plan = fields.Char(
        string="Subscription Plan",
        compute="_compute_license_status",
        readonly=True,
    )
    license_expires_at = fields.Char(
        string="License Expires At",
        compute="_compute_license_status",
        readonly=True,
    )
    license_limits = fields.Char(
        string="License Limits",
        compute="_compute_license_status",
        readonly=True,
    )
    license_active_agents = fields.Integer(
        string="Active Agents",
        compute="_compute_license_status",
        readonly=True,
    )
    license_active_printers = fields.Integer(
        string="Shared Printers",
        compute="_compute_license_status",
        readonly=True,
    )
    license_usage_summary = fields.Char(
        string="License Usage",
        compute="_compute_license_status",
        readonly=True,
    )

    _company_unique = models.Constraint(
        "UNIQUE(company_id)",
        "Only one Direct Odoo Print Service configuration is allowed per company.",
    )

    def _check_admin(self):
        if not (self.env.is_superuser() or self.env.user.has_group("base.group_system")):
            raise AccessError(_("Only Odoo system administrators can change print service settings."))

    @api.constrains("company_id")
    def _check_root_company(self):
        for record in self:
            if record.company_id.parent_id:
                raise ValidationError(_("Select a root Odoo Company. Branches are configured under that company."))

    @api.model_create_multi
    def create(self, vals_list):
        self._check_admin()
        return super().create(vals_list)

    def write(self, vals):
        if {"company_id", "enabled"}.intersection(vals):
            self._check_admin()
        return super().write(vals)

    def unlink(self):
        self._check_admin()
        return super().unlink()

    def _compute_license_config(self):
        icp = self.env["ir.config_parameter"].sudo()
        is_admin = self.env.is_superuser() or self.env.user.has_group("base.group_system")
        server_url = (icp.get_param("print_gateway.license_server_url") or "").strip()
        api_key = (icp.get_param("print_gateway.license_key") or "").strip() if is_admin else ""
        pub_key = _resolve_license_public_key(icp)
        for record in self:
            record.license_server_url = server_url
            record.license_api_key = api_key
            record.license_public_key_b64 = pub_key

    def _inverse_license_server_url(self):
        self._check_admin()
        icp = self.env["ir.config_parameter"].sudo()
        for record in self:
            icp.set_param("print_gateway.license_server_url", (record.license_server_url or "").strip().rstrip("/"))

    def _inverse_license_api_key(self):
        self._check_admin()
        icp = self.env["ir.config_parameter"].sudo()
        for record in self:
            icp.set_param("print_gateway.license_key", (record.license_api_key or "").strip())

    def _inverse_license_public_key_b64(self):
        self._check_admin()
        if (PINNED_LICENSE_PUBLIC_KEY_B64 or "").strip():
            return
        icp = self.env["ir.config_parameter"].sudo()
        for record in self:
            icp.set_param("print_gateway.license_public_key_b64", (record.license_public_key_b64 or "").strip())

    def _compute_license_status(self):
        if not self:
            return
        icp = self.env["ir.config_parameter"].sudo()
        db_uuid = (icp.get_param("database.uuid") or "").strip()
        ok, reason, bundle = verify_stored_license_bundle(icp)
        claims = bundle.get("payload") if isinstance(bundle, dict) and isinstance(bundle.get("payload"), dict) else {}
        status_label = _("Active") if ok else _("Invalid (%s)", reason)
        plan = str(claims.get("plan") or "-")
        expires = str(claims.get("expires_at") or "-")
        max_agents = claims.get("max_agents")
        max_printers = claims.get("max_printers")
        limits = (
            _("%s Agents / %s Printers", max_agents, max_printers)
            if isinstance(max_agents, int) and isinstance(max_printers, int)
            else "-"
        )
        cr = self.env.cr
        cr.execute(
            """
            SELECT count(*)
              FROM print_gateway_agent
             WHERE active = TRUE
               AND token_hash IS NOT NULL
               AND token_hash <> ''
            """
        )
        active_agents = int((cr.fetchone() or (0,))[0] or 0)
        cr.execute(
            """
            SELECT count(*)
              FROM print_gateway_printer pr
              JOIN print_gateway_agent a ON a.id = pr.agent_id
             WHERE a.active = TRUE
               AND pr.available_to_odoo = TRUE
            """
        )
        active_printers = int((cr.fetchone() or (0,))[0] or 0)
        if ok and isinstance(max_agents, int) and isinstance(max_printers, int):
            agent_cap = str(max_agents) if max_agents > 0 else _("Unlimited")
            printer_cap = str(max_printers) if max_printers > 0 else _("Unlimited")
            usage_summary = _(
                "%(agents)s/%(max_agents)s Agents · %(printers)s/%(max_printers)s Printers",
                agents=active_agents,
                max_agents=agent_cap,
                printers=active_printers,
                max_printers=printer_cap,
            )
        else:
            usage_summary = _(
                "%(agents)s Agents · %(printers)s Printers (license inactive)",
                agents=active_agents,
                printers=active_printers,
            )
        for record in self:
            record.odoo_db_uuid = db_uuid or "-"
            record.license_status = status_label
            record.license_plan = plan
            record.license_expires_at = expires
            record.license_limits = limits
            record.license_active_agents = active_agents
            record.license_active_printers = active_printers
            record.license_usage_summary = usage_summary

    def action_refresh_license(self):
        self.ensure_one()
        self._check_admin()
        refreshed = self.sudo().cron_refresh_license_bundle()
        ok, reason, _bundle = verify_stored_license_bundle(self.env["ir.config_parameter"].sudo())
        if refreshed and ok:
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("License Activated"),
                    "message": _("Signed Ed25519 license verified and synced to connected agents."),
                    "type": "success",
                    "sticky": False,
                },
            }
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("License Verification Failed"),
                "message": _("Could not activate license (%s). Check Gateway URL, API key, public key, and subscription status.", reason),
                "type": "danger",
                "sticky": True,
            },
        }

    def action_open_pairing_wizard(self):
        self.ensure_one()
        self._check_admin()
        return {
            "type": "ir.actions.act_window",
            "name": _("Assign Print Agent"),
            "res_model": "print_gateway.pair_agent_wizard",
            "view_mode": "form",
            "target": "new",
            "context": {"default_config_id": self.id},
        }

    def _check_navigation_admin(self):
        self.ensure_one()
        self._check_admin()
        self.check_access("read")

    def action_open_runtime_assignments(self):
        self._check_navigation_admin()
        return {
            "type": "ir.actions.act_window",
            "name": _("Agent Assignments"),
            "res_model": "print_gateway.runtime_agent_assignment",
            "view_mode": "list,form",
            "domain": [("company_id", "=", self.company_id.id)],
            "context": {"default_company_id": self.company_id.id},
        }

    def action_open_destinations(self):
        self._check_navigation_admin()
        context = {"default_company_id": self.company_id.id}
        if self.env.company.parent_id == self.company_id and self.env.company in self.env.companies:
            context["default_branch_id"] = self.env.company.id
        return {
            "type": "ir.actions.act_window",
            "name": _("Print Routing"),
            "res_model": "print_gateway.binding",
            "view_mode": "list,form",
            "domain": [("company_id", "=", self.company_id.id)],
            "context": context,
        }

    def action_open_print_rules(self):
        self._check_navigation_admin()
        return {
            "type": "ir.actions.act_window",
            "name": _("Automatic Printing"),
            "res_model": "print_gateway.policy",
            "view_mode": "list,form",
            "domain": [("company_id", "=", self.company_id.id)],
            "context": {"default_company_id": self.company_id.id},
        }

    @api.model
    @api.private
    def cron_refresh_license_bundle(self):
        """Refresh the signed entitlement. A network failure keeps the last bundle."""
        self._check_admin()
        icp = self.env["ir.config_parameter"].sudo()
        server_url = (icp.get_param("print_gateway.license_server_url") or "").strip().rstrip("/")
        license_key = (icp.get_param("print_gateway.license_key") or "").strip()
        db_uuid = (icp.get_param("database.uuid") or "").strip()
        pub_key_b64 = _resolve_license_public_key(icp)
        if not server_url or not license_key or not db_uuid:
            return False
        try:
            from . import cloud_http as requests

            payload = {"odooDbUuid": db_uuid}
            tenant_id = (icp.get_param("print_gateway.tenant_id") or "").strip()
            if tenant_id:
                payload["tenantId"] = tenant_id
            prior_raw = (icp.get_param("print_gateway.signed_license_bundle") or "").strip()
            if prior_raw:
                try:
                    prior_bundle = json.loads(prior_raw)
                except (TypeError, ValueError):
                    prior_bundle = None
                prior_rev = _extract_bundle_rev(prior_bundle)
                if prior_rev is not None and prior_rev > 0:
                    payload["prevRev"] = prior_rev
            response = requests.post(
                f"{server_url}/api/license/refresh",
                headers={"Authorization": f"Bearer {license_key}"},
                json=payload,
                timeout=10,
                allow_redirects=False,
            )
            if response.status_code not in (200, 403):
                _logger.warning("Cloud licence refresh returned HTTP %s", response.status_code)
                return False
            body = response.json()
            bundle = body.get("bundle") if isinstance(body, dict) else None
            if not isinstance(bundle, dict):
                _logger.warning("Cloud licence refresh returned no signed bundle (HTTP %s)", response.status_code)
                return False

            ok, reason = _validate_license_bundle(
                bundle,
                expected_db_uuid=db_uuid,
                pub_key_b64=pub_key_b64,
                check_expiry=False,
            )
            is_revoked_tombstone = reason == "license_revoked"
            if response.status_code == 403 and not is_revoked_tombstone:
                _logger.warning("Cloud licence refresh HTTP 403 did not contain a valid revoked tombstone (%s)", reason)
                return False
            if not ok and not is_revoked_tombstone:
                _logger.warning("Cloud licence refresh rejected invalid bundle: %s", reason)
                return False

            # Monotonic rev anti-rollback: never overwrite a newer revision for the same DB UUID.
            new_rev = _extract_bundle_rev(bundle)
            existing_raw = (icp.get_param("print_gateway.signed_license_bundle") or "").strip()
            if existing_raw:
                try:
                    existing_bundle = json.loads(existing_raw)
                except (TypeError, ValueError):
                    existing_bundle = None
                existing_claims = existing_bundle.get("payload") if isinstance(existing_bundle, dict) else None
                existing_db_uuid = str((existing_claims or {}).get("odoo_db_uuid") or "").strip()
                existing_status = str((existing_claims or {}).get("status") or "").strip().lower()
                existing_rev = _extract_bundle_rev(existing_bundle)
                same_db = not existing_db_uuid or existing_db_uuid == db_uuid
                rollback_conflict = new_rev < existing_rev or (
                    existing_status == "revoked" and not is_revoked_tombstone and new_rev <= existing_rev
                )
                if existing_rev is not None and same_db and rollback_conflict:
                    _logger.warning(
                        "Cloud licence refresh rejected rollback: incoming rev %s < stored rev %s",
                        new_rev,
                        existing_rev,
                    )
                    return False

            icp.set_param("print_gateway.signed_license_bundle", json.dumps(bundle))
            try:
                with self.env.cr.savepoint():
                    self.env.cr.execute(
                        "SELECT pg_notify('print_gateway_license_updated', %s)",
                        (db_uuid,),
                    )
            except Exception as exc:
                _logger.debug("pg_notify print_gateway_license_updated skipped: %s", exc)
            return True
        except Exception:
            _logger.warning("Cloud licence refresh failed against %s", server_url, exc_info=True)
            return False


class PrintGatewayPairAgentWizard(models.TransientModel):
    _name = "print_gateway.pair_agent_wizard"
    _description = "Assign Direct Odoo Print Agent"

    config_id = fields.Many2one(
        "print_gateway.gateway_config",
        string="Print Service Configuration",
        required=True,
        ondelete="cascade",
    )
    company_id = fields.Many2one("res.company", related="config_id.company_id", readonly=True)
    branch_id = fields.Many2one(
        "res.company",
        string="Branch",
        domain="[('parent_id', '=', company_id)]",
        required=False,
    )
    agent_record_id = fields.Many2one(
        "print_gateway.agent",
        string="Registered Print Agent",
        required=True,
        domain="[('company_id', '=', company_id), ('active', '=', True)]",
        help="Select an Agent that has already paired directly with this Odoo database.",
    )

    def action_confirm_pairing(self):
        self.ensure_one()
        if not (self.env.is_superuser() or self.env.user.has_group("base.group_system")):
            raise AccessError(_("Only Odoo system administrators can assign Print Agents."))
        config = self.config_id
        agent = self.agent_record_id.exists()
        if not agent or agent.company_id != config.company_id or not agent.active:
            raise ValidationError(_("Select an active Agent registered to this Odoo Company."))
        branch = self.branch_id or False
        if branch and branch.parent_id != config.company_id:
            raise ValidationError(_("The selected Branch must belong directly to this Odoo Company."))
        if branch and branch not in self.env.companies and not self.env.is_superuser():
            raise AccessError(_("You cannot assign an Agent to this Branch."))

        assignments = self.env["print_gateway.runtime_agent_assignment"]
        domain = [
            ("company_id", "=", config.company_id.id),
            ("branch_id", "=", branch.id if branch else False),
            ("agent_id", "=", agent.id),
        ]
        assignment = assignments.search(domain, limit=1)
        if not assignment:
            assignments.create({
                "company_id": config.company_id.id,
                "branch_id": branch.id if branch else False,
                "agent_id": agent.id,
                "enabled": True,
            })
        elif not assignment.enabled:
            assignment.write({"enabled": True})

        scope_name = branch.display_name if branch else config.company_id.display_name
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Agent Assigned"),
                "message": _("Agent %s is assigned to %s.") % (agent.name or agent.agent_uid, scope_name),
                "type": "success",
                "sticky": False,
            },
        }
