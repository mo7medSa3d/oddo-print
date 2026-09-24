# -*- coding: utf-8 -*-
"""Durable Idempotent Intent tracking to prevent duplicate event-driven print dispatch."""

import datetime
import hashlib
import logging
import uuid

from psycopg2 import IntegrityError
from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError

from ..runtime_clock import db_now_utc

_logger = logging.getLogger(__name__)


class PrintGatewayIntent(models.Model):
    _name = "print_gateway.intent"
    _description = "Print Gateway Dispatch Intent"
    _order = "create_date desc"

    company_id = fields.Many2one(
        "res.company", string="Company", default=lambda self: self.env.company,
        index=True, ondelete="restrict",
    )
    intent_key = fields.Char(string="Idempotency Intent Key", required=True, index=True, readonly=True)
    policy_id = fields.Many2one("print_gateway.policy", string="Policy", required=True, ondelete="restrict")
    res_model = fields.Char(string="Source Model", required=True, index=True)
    res_id = fields.Integer(string="Source ID", required=True, index=True)
    event_type = fields.Char(string="Event Type", required=True)
    print_job_id = fields.Many2one("print_gateway.print_job", string="Resulting Outbox Job", ondelete="set null")

    status = fields.Selection([
        ("pending", "Pending Commit"),
        ("claimed", "Claimed / In Flight"),
        ("dispatched", "Dispatched"),
        ("skipped", "Skipped"),
        ("failed", "Routing Failed"),
    ], string="Dispatch Status", default="pending", required=True, index=True)

    attempts = fields.Integer(string="Attempt Count", default=0, required=True)
    max_attempts = fields.Integer(string="Max Attempts", default=3, required=True)
    next_retry_at = fields.Datetime(string="Next Retry At", index=True)
    last_error = fields.Text(string="Last Error", readonly=True)
    claimed_at = fields.Datetime(string="Claimed At", index=True)
    claim_token = fields.Char(string="Claim Token", copy=False, index=True)

    _intent_unique = models.Constraint(
        "UNIQUE(intent_key)",
        "An automated print event with this identical intent key has already been captured.",
    )

    _VALID_INTENT_TRANSITIONS = {
        "pending": {"pending", "claimed", "skipped"},
        "claimed": {"claimed", "dispatched", "failed", "skipped", "pending"},
        "dispatched": {"dispatched"},
        "skipped": {"skipped"},
        "failed": {"failed", "pending"},
    }

    def write(self, vals):
        if "status" in vals:
            target = vals["status"]
            for record in self:
                if record.status and target != record.status:
                    allowed = self._VALID_INTENT_TRANSITIONS.get(record.status, set())
                    if target not in allowed:
                        raise ValidationError(
                            _("Invalid intent state transition from '%s' to '%s'.")
                            % (record.status, target)
                        )
                    # Worker transition from claimed to pending requires active recovery context or valid claim token
                    if record.status == "claimed" and target == "pending":
                        if not self.env.context.get("allow_lease_recovery") and not (
                            vals.get("claim_token") == record.claim_token and record.claim_token
                        ):
                            raise ValidationError(
                                _("Transition from 'claimed' to 'pending' requires valid claim ownership or lease recovery context.")
                            )
        return super().write(vals)

    @api.model
    def compute_intent_key(self, policy, record, event_type):
        raw = f"{record._name}:{record.id}:{event_type}:{policy.id}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @classmethod
    def _claim_intent(cls, env, intent_id, cr=None):
        """Atomically claim intent with a unique token in an independent transaction (or provided cursor).
        Returns claim_token if acquired, or None if already claimed, fresh, or non-retryable."""
        claim_token = uuid.uuid4().hex
        manage_cr = cr is None
        try:
            target_cr = env.registry.cursor() if manage_cr else cr
            now = db_now_utc(target_cr)
            stale_threshold = now - datetime.timedelta(minutes=5)
            try:
                target_cr.execute("""
                    UPDATE print_gateway_intent
                    SET status = 'claimed', claimed_at = %s, claim_token = %s, attempts = attempts + 1
                    WHERE id = %s AND (
                        (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= %s)) OR
                        (status = 'claimed' AND attempts < max_attempts AND (claimed_at IS NULL OR claimed_at <= %s)) OR
                        (status = 'failed' AND attempts < max_attempts AND (next_retry_at IS NULL OR next_retry_at <= %s))
                    )
                """, (now, claim_token, intent_id, now, stale_threshold, now))
                if target_cr.rowcount > 0:
                    if manage_cr:
                        target_cr.commit()
                    return claim_token
            finally:
                if manage_cr:
                    target_cr.close()
        except Exception as exc:
            _logger.error("Failed to claim print intent %s: %s", intent_id, exc)
        return None

    @classmethod
    def _finalize_intent_state(cls, env, intent_id, claim_token, status, print_job_id=None, last_error=None, next_retry_at=None, cr=None):
        """Atomically finalize intent state strictly protected by the fencing claim_token.
        Returns True if updated, False if lease was superseded by another worker."""
        if not claim_token:
            return False
        manage_cr = cr is None
        try:
            target_cr = env.registry.cursor() if manage_cr else cr
            try:
                target_cr.execute("""
                    UPDATE print_gateway_intent
                    SET status = %s,
                        print_job_id = %s,
                        last_error = %s,
                        next_retry_at = %s,
                        claimed_at = CASE WHEN %s IN ('pending', 'dispatched', 'skipped', 'failed') THEN NULL ELSE claimed_at END,
                        claim_token = CASE WHEN %s IN ('pending', 'dispatched', 'skipped', 'failed') THEN NULL ELSE claim_token END,
                        write_date = NOW() AT TIME ZONE 'UTC'
                    WHERE id = %s AND claim_token = %s
                """, (status, print_job_id, last_error, next_retry_at, status, status, intent_id, claim_token))
                if target_cr.rowcount > 0:
                    if manage_cr:
                        target_cr.commit()
                    return True
                else:
                    _logger.warning("Fencing token mismatch for intent %s; lease was superseded by another worker.", intent_id)
                    return False
            finally:
                if manage_cr:
                    target_cr.close()
        except Exception as exc:
            _logger.error("Failed to finalize intent %s: %s", intent_id, exc)
            return False

    @classmethod
    def _execute_dispatched_route(cls, env, intent_id, res_model, res_id, claim_token):
        """Execute network/gateway dispatch using an already acquired claim_token."""
        if not claim_token:
            return
        cr = env.registry.cursor()
        try:
            new_env = api.Environment(cr, env.uid, dict(env.context))
            intent = new_env["print_gateway.intent"].browse(intent_id).exists()
            if not intent or intent.claim_token != claim_token:
                _logger.warning("Intent %s claim token mismatch before routing; skipping.", intent_id)
                return
            record = new_env[res_model].browse(res_id).exists()
            if not record:
                cls._finalize_intent_state(
                    env, intent_id, claim_token,
                    status="skipped",
                    last_error="Source record no longer exists",
                )
                return
            # The routing boundary asserts env.company == record.company_id.
            # In the post-commit path the operator's env already matches, but
            # the cron recovery path runs under the cron user's default
            # company, which permanently stranded branch-scoped intents
            # (marked failed after max_attempts). Route under the record's
            # own company so recovery works for every scope; it is a no-op
            # where the env already matches. Odoo 19 resolves env.company
            # from allowed_company_ids[0] (Environment has no with_company),
            # and narrowing the allowed list below the operator's own scope
            # can only ever restrict access, never widen it.
            record_company = record.company_id if hasattr(record, "company_id") else False
            if record_company and record_company.id != new_env.company.id:
                new_env = new_env(context=dict(new_env.context, allowed_company_ids=[record_company.id]))
                intent = intent.with_env(new_env)
                record = record.with_env(new_env)
            router = new_env["print_gateway.print_router"]
            try:
                route_res = router.route_intent(intent, record)
                if route_res and route_res.get("job_id"):
                    cls._finalize_intent_state(
                        env, intent_id, claim_token,
                        status="dispatched",
                        print_job_id=route_res["job_id"],
                        last_error=False,
                    )
                elif route_res and route_res.get("status") in ("skipped", "no_action"):
                    cls._finalize_intent_state(
                        env, intent_id, claim_token,
                        status="skipped",
                    )
                else:
                    cls._finalize_intent_state(
                        env, intent_id, claim_token,
                        status="dispatched",
                        last_error=False,
                    )
            except Exception as exc:
                _logger.warning("Failed to route print intent %s for %s(%s): %s", intent.intent_key[:12], res_model, res_id, exc)
                next_retry = False
                if intent.attempts < intent.max_attempts:
                    delay_sec = min(300, 15 * (2 ** max(0, intent.attempts - 1)))
                    next_retry = db_now_utc(cr) + datetime.timedelta(seconds=delay_sec)
                target_status = "failed" if intent.attempts >= intent.max_attempts else "pending"
                cls._finalize_intent_state(
                    env, intent_id, claim_token,
                    status=target_status,
                    last_error=str(exc),
                    next_retry_at=next_retry,
                )
        except Exception as exc:
            _logger.error("Error in dispatched route execution for intent %s: %s", intent_id, exc)
        finally:
            cr.close()

    @classmethod
    def _dispatch_intent_postcommit(cls, env, intent_id, res_model, res_id):
        """Execute network/gateway dispatch strictly after the enclosing database transaction commits."""
        claim_token = cls._claim_intent(env, intent_id)
        if not claim_token:
            return
        cls._execute_dispatched_route(env, intent_id, res_model, res_id, claim_token)

    @api.model
    @api.private
    def create_and_route(self, policy, record, event_type):
        """Idempotently creates intent or re-arms retryable intent and registers post-commit callback."""
        key = self.compute_intent_key(policy, record, event_type)
        existing = self.search([("intent_key", "=", key)], limit=1)
        if existing:
            if existing.status in ("dispatched", "skipped"):
                _logger.info("Print intent %s already completed (%s) for %s(%s); skipping duplicate dispatch.", key[:12], existing.status, record._name, record.id)
                return existing
            elif existing.status == "claimed":
                now = db_now_utc(self.env.cr)
                if existing.claimed_at and (now - existing.claimed_at).total_seconds() < 300:
                    _logger.info("Print intent %s is actively being processed by another worker; skipping duplicate dispatch.", key[:12])
                    return existing

            # Permanently failed intent requires explicit operator intervention
            if existing.status == "failed" and existing.attempts >= existing.max_attempts:
                _logger.info("Print intent %s is permanently failed (%d attempts); manual operator re-arm required.", key[:12], existing.attempts)
                return existing

            intent_id = existing.id
            res_model = record._name
            res_id = record.id
            self.env.cr.postcommit.add(lambda: self._dispatch_intent_postcommit(self.env, intent_id, res_model, res_id))
            return existing

        company_id = record.company_id.id if hasattr(record, "company_id") and record.company_id else self.env.company.id
        try:
            with self.env.cr.savepoint():
                intent = self.create({
                    "company_id": company_id,
                    "intent_key": key,
                    "policy_id": policy.id,
                    "res_model": record._name,
                    "res_id": record.id,
                    "event_type": event_type,
                    "status": "pending",
                })
        except IntegrityError:
            _logger.info("Concurrent intent creation detected for %s; skipping.", key[:12])
            return self.search([("intent_key", "=", key)], limit=1)

        # Register post-commit hook so Gateway dispatch happens ONLY after PostgreSQL commit
        intent_id = intent.id
        res_model = record._name
        res_id = record.id
        self.env.cr.postcommit.add(lambda: self._dispatch_intent_postcommit(self.env, intent_id, res_model, res_id))

        return intent

    def action_rearm_intent(self):
        failed_intents = self.filtered(lambda i: i.status == "failed")
        if not failed_intents:
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("No Intents Re-armed"),
                    "message": _("No eligible failed intents were selected for re-arming."),
                    "type": "warning",
                    "sticky": False,
                },
            }
        for intent in failed_intents:
            intent.write({
                "status": "pending",
                "attempts": 0,
                "last_error": False,
                "next_retry_at": False,
                "claim_token": False,
                "claimed_at": False,
            })
            self.env.cr.postcommit.add(
                lambda i_id=intent.id, m=intent.res_model, r_id=intent.res_id:
                self._dispatch_intent_postcommit(self.env, i_id, m, r_id)
            )
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Intents Re-armed"),
                "message": _("%d failed intent(s) re-armed for immediate dispatch.") % len(failed_intents),
                "type": "success",
                "sticky": False,
            },
        }

    @api.model
    @api.private
    def cron_recover_pending_intents(self):
        """Recover stranded or crashed print intents across worker/server restarts."""
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only scheduled actions (administrator) may run this method."))
        now = db_now_utc(self.env.cr)
        stale_threshold = now - datetime.timedelta(minutes=5)

        # Select exactly the retryable states at the SQL boundary. A domain
        # cannot compare attempts to max_attempts, so a plain search can fill
        # the 50-row batch with permanently failed intents and starve newer
        # retryable work forever. Exclude exhausted failures in SQL itself.
        self.env.cr.execute("""
            SELECT id
            FROM print_gateway_intent
            WHERE
                (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= %s))
                OR
                (status = 'claimed' AND (claimed_at IS NULL OR claimed_at <= %s))
                OR
                (status = 'failed' AND attempts < max_attempts
                    AND (next_retry_at IS NULL OR next_retry_at <= %s))
            ORDER BY id ASC
            LIMIT 50
        """, (now, stale_threshold, now))
        candidate_ids = [row[0] for row in self.env.cr.fetchall()]
        candidates = self.browse(candidate_ids)

        cron = self.env["ir.cron"]
        remaining_time = cron._commit_progress(remaining=len(candidates))
        recovered_count = 0
        for candidate in candidates:
            if remaining_time <= 0:
                break

            # A crash after the final dispatch claim otherwise leaves the
            # intent permanently in 'claimed': _claim_intent() rejects it once
            # attempts reaches max_attempts, so no future worker can recover it.
            # The candidate is already outside the five-minute lease window;
            # once the attempt ceiling is exhausted, terminalize it explicitly
            # and require manual operator re-arm rather than leaving an
            # automation event wedged forever.
            if candidate.status == "claimed" and candidate.attempts >= candidate.max_attempts:
                recovered = candidate.with_context(allow_lease_recovery=True).write({
                    "status": "failed",
                    "claimed_at": False,
                    "claim_token": False,
                    "next_retry_at": False,
                    "last_error": "Dispatch lease expired after the final attempt; manual operator re-arm required.",
                })
                if recovered:
                    recovered_count += 1
                remaining_time = cron._commit_progress(1)
                continue

            if candidate.attempts < candidate.max_attempts:
                claim_token = self._claim_intent(self.env, candidate.id)
                if claim_token:
                    self._execute_dispatched_route(self.env, candidate.id, candidate.res_model, candidate.res_id, claim_token)
                    recovered_count += 1
            remaining_time = cron._commit_progress(1)
        return recovered_count

