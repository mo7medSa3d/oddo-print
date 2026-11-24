# -*- coding: utf-8 -*-
import datetime
import secrets

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, ValidationError

from .crypto import CredentialError, hash_agent_pairing_code
from .print_config import check_license_limits


class PrintGatewayAgent(models.Model):
    _name = "print_gateway.agent"
    _description = "Direct Local Print Agent"
    _order = "name asc, id asc"

    name = fields.Char(required=True)
    company_id = fields.Many2one(
        "res.company",
        required=True,
        default=lambda self: self.env.company.parent_id or self.env.company,
        domain="[('parent_id', '=', False)]",
        ondelete="restrict",
        index=True,
    )
    agent_uid = fields.Char(required=True, index=True, copy=False, default=lambda self: f"agt_{secrets.token_hex(4)}")
    pairing_code_hash = fields.Char(index=True, copy=False, groups="base.group_system")
    pairing_expires_at = fields.Datetime(copy=False, groups="base.group_system")
    token_hash = fields.Char(index=True, copy=False, groups="base.group_system")
    status = fields.Selection(
        [("online", "Online"), ("offline", "Offline")],
        default="offline",
        required=True,
    )
    agent_version = fields.Char()
    last_seen_at = fields.Datetime(index=True)
    active = fields.Boolean(default=True)
    printer_ids = fields.One2many("print_gateway.printer", "agent_id", string="Printers")

    _agent_uid_company_uniq = models.Constraint(
        "unique(company_id, agent_uid)",
        "Agent UID must be unique per company.",
    )

    @api.constrains("company_id")
    def _check_root_company(self):
        for record in self:
            if record.company_id.parent_id:
                raise ValidationError(_("Select a root Odoo Company. Branches are configured under that company."))

    def init(self):
        super().init()
        # Partial indexes for hot Bearer token auth and stale-agent cron sweep.
        self.env.cr.execute(
            """
            CREATE INDEX IF NOT EXISTS print_gateway_agent_active_token_idx
            ON print_gateway_agent (token_hash)
            WHERE active = TRUE AND token_hash IS NOT NULL AND token_hash <> ''
            """
        )
        self.env.cr.execute(
            """
            CREATE INDEX IF NOT EXISTS print_gateway_agent_online_last_seen_idx
            ON print_gateway_agent (last_seen_at, id)
            WHERE status = 'online'
            """
        )

    @api.model
    def hash_secret(self, raw_value):
        # Kept as a model method for compatibility with existing integrations,
        # but pairing digests are now keyed; do not fall back to raw SHA-256.
        return hash_agent_pairing_code(raw_value)

    def action_generate_pairing_code(self):
        self.ensure_one()
        if not (self.env.is_superuser() or self.env.user.has_group("base.group_system")):
            raise AccessError(_("Only Odoo system administrators can generate agent pairing codes."))
        self.check_access("write")
        raw_code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
        try:
            code_hash = self.hash_secret(raw_code)
        except CredentialError as exc:
            raise ValidationError(_("Agent pairing is unavailable because the deployment credential key is not configured.")) from exc
        expires = fields.Datetime.now() + datetime.timedelta(minutes=15)
        self.sudo().write({
            "pairing_code_hash": code_hash,
            "pairing_expires_at": expires,
        })
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Agent Pairing Code (15 min)"),
                "message": raw_code,
                "sticky": True,
                "type": "info",
            },
        }

    def write(self, vals):
        if vals.get("active") is True and not (self.env.is_superuser() and self.env.context.get("skip_agent_limit_check")):
            self.env.cr.execute("SELECT pg_advisory_xact_lock(hashtext('print_gateway_agent_limit'))")
            reactivating = self.filtered(lambda a: not a.active and bool(a.token_hash))
            if reactivating:
                self.env.cr.execute(
                    """
                    SELECT count(*)
                      FROM print_gateway_agent
                     WHERE active = TRUE
                       AND token_hash IS NOT NULL
                       AND token_hash <> ''
                    """
                )
                current_active = int(self.env.cr.fetchone()[0] or 0)
                projected = current_active + len(reactivating)
                icp = self.env["ir.config_parameter"].sudo()
                ok, reason, bundle = check_license_limits(icp, active_agents=projected)
                if not ok:
                    max_a = int(((bundle or {}).get("payload") or {}).get("max_agents") or 0)
                    if reason == "max_agents_exceeded" and max_a > 0:
                        raise ValidationError(
                            _("Agent limit reached (%(current)s / %(max)s). Archive or revoke another agent before reactivating this one.")
                            % {"current": current_active, "max": max_a}
                        )
                    raise ValidationError(_("Cannot activate agent because license check failed (%s).") % reason)

        if vals.get("active") is False:
            vals = dict(vals)
            vals.setdefault("status", "offline")

        res = super().write(vals)

        if vals.get("active") is False:
            self.sudo().mapped("printer_ids").with_context(skip_printer_limit_check=True).write({
                "available_to_odoo": False,
            })
            self.env.cr.execute("NOTIFY print_gateway_license_updated")
        return res

    def unlink(self):
        had_active = any(a.active or bool(a.sudo().token_hash) for a in self)
        res = super().unlink()
        if had_active:
            self.env.cr.execute("NOTIFY print_gateway_license_updated")
        return res

    def action_revoke_disconnect(self):
        self.ensure_one()
        if not (self.env.is_superuser() or self.env.user.has_group("base.group_system")):
            raise AccessError(_("Only Odoo system administrators can revoke print agents."))
        self.check_access("write")
        self.sudo().write({
            "token_hash": False,
            "pairing_code_hash": False,
            "pairing_expires_at": False,
            "status": "offline",
        })
        self.sudo().mapped("printer_ids").with_context(skip_printer_limit_check=True).write({
            "available_to_odoo": False,
        })
        self.env.cr.execute("NOTIFY print_gateway_license_updated")
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Agent Revoked"),
                "message": _("Agent '%s' has been disconnected and its token revoked.") % self.name,
                "sticky": False,
                "type": "warning",
            },
        }

    @api.model
    def _cron_sweep_stale_agents(self, stale_minutes=2, lease_minutes=3, batch_limit=500):
        """Mark silent Agents offline and recover only safe pre-dispatch claims."""
        cr = self.env.cr
        limit = max(1, int(batch_limit))
        cr.execute(
            """
            WITH target AS (
                SELECT id
                  FROM print_gateway_agent
                 WHERE status = 'online'
                   AND last_seen_at IS NOT NULL
                   AND last_seen_at < clock_timestamp() - (%s * interval '1 minute')
                 ORDER BY id ASC
                 LIMIT %s
                 FOR UPDATE SKIP LOCKED
            )
            UPDATE print_gateway_agent a
               SET status = 'offline',
                   write_date = clock_timestamp()
              FROM target
             WHERE a.id = target.id
            """,
            (int(stale_minutes), limit),
        )
        # `claimed` is pre-dispatch: the Agent must receive and acknowledge
        # the `printing` transition before it may send a physical byte.
        # Exhausted claims (attempts >= 5) fail terminally; remaining stale
        # claims return to the queue safely.
        cr.execute(
            """
            WITH target AS (
                SELECT id
                  FROM print_gateway_print_job
                 WHERE status = 'claimed'
                   AND write_date < clock_timestamp() - (%s * interval '1 minute')
                   AND COALESCE(attempts, 0) >= 5
                 ORDER BY id ASC
                 LIMIT %s
                 FOR UPDATE SKIP LOCKED
            )
            UPDATE print_gateway_print_job j
               SET status = 'failed',
                   last_error = 'AGENT_CLAIM_EXHAUSTED: Agent did not acknowledge printing before the claim lease expired; inspect the printer and explicitly reprint if needed.',
                   claim_token = NULL,
                   claimed_at = NULL,
                   completed_at = clock_timestamp(),
                   write_date = clock_timestamp()
              FROM target
             WHERE j.id = target.id
            """,
            (int(lease_minutes), limit),
        )
        cr.execute(
            """
            WITH target AS (
                SELECT id
                  FROM print_gateway_print_job
                 WHERE status = 'claimed'
                   AND write_date < clock_timestamp() - (%s * interval '1 minute')
                   AND COALESCE(attempts, 0) < 5
                   AND COALESCE(payload, '') <> ''
                 ORDER BY id ASC
                 LIMIT %s
                 FOR UPDATE SKIP LOCKED
            )
            UPDATE print_gateway_print_job j
               SET status = 'queued',
                   last_error = NULL,
                   claim_token = NULL,
                   claimed_at = NULL,
                   write_date = clock_timestamp()
              FROM target
             WHERE j.id = target.id
         RETURNING j.company_id
            """,
            (int(lease_minutes), limit),
        )
        requeued_companies = sorted({r[0] for r in cr.fetchall() if r and r[0]})
        if requeued_companies:
            cr.execute(
                "SELECT DISTINCT COALESCE(parent_id, id) FROM res_company WHERE id = ANY(%s)",
                (requeued_companies,),
            )
            for (root_cid,) in cr.fetchall():
                if root_cid:
                    cr.execute("SELECT pg_notify('print_gateway_job_ready', %s)", (str(root_cid),))
        # Once `printing` has been acknowledged, output may already have
        # reached the physical device. Reclaiming this row would risk a
        # duplicate page after an Agent/network failure. Preserve the payload
        # for operator reconciliation, but make the outcome terminal unknown.
        cr.execute(
            """
            WITH target AS (
                SELECT id
                  FROM print_gateway_print_job
                 WHERE status = 'printing'
                   AND write_date < clock_timestamp() - (%s * interval '1 minute')
                   AND COALESCE(payload, '') <> ''
                 ORDER BY id ASC
                 LIMIT %s
                 FOR UPDATE SKIP LOCKED
            )
            UPDATE print_gateway_print_job j
               SET status = 'unknown',
                   last_error = 'UNKNOWN_PARTIAL_DELIVERY: Agent lease expired after the printing transition; physical output is unverified and automatic retry is unsafe.',
                   claim_token = NULL,
                   claimed_at = NULL,
                   completed_at = clock_timestamp(),
                   write_date = clock_timestamp()
              FROM target
             WHERE j.id = target.id
            """,
            (int(lease_minutes), limit),
        )
        return True
