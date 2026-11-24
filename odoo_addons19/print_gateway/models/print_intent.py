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
        required=True, index=True, ondelete="restrict",
    )
    intent_key = fields.Char(string="Idempotency Intent Key", required=True, index=True, readonly=True)
    policy_id = fields.Many2one("print_gateway.policy", string="Policy", required=True, ondelete="restrict", index=True)
    res_model = fields.Char(string="Source Model", required=True, index=True)
    res_id = fields.Integer(string="Source ID", required=True, index=True)
    event_type = fields.Char(string="Event Type", required=True)
    print_job_id = fields.Many2one("print_gateway.print_job", string="Resulting Outbox Job", ondelete="set null", index=True)

    status = fields.Selection([
        ("pending", "Pending"),
        ("claimed", "Claimed / In Flight"),
        ("dispatched", "Dispatched"),
        ("skipped", "Skipped"),
        ("failed", "Routing Failed"),
    ], string="Dispatch Status", default="pending", required=True, index=True)

    attempts = fields.Integer(string="Attempt Count", default=0, required=True)
    max_attempts = fields.Integer(string="Max Attempts", default=3, required=True)
    next_retry_at = fields.Datetime(string="Next Retry At", index=True)
    last_error = fields.Text(string="Last Error", readonly=True)
    customer_issue = fields.Text(string="What to do next", compute="_compute_customer_issue", compute_sudo=False)
    claimed_at = fields.Datetime(string="Claimed At", index=True)
    claim_token = fields.Char(string="Claim Token", copy=False, index=True)

    @api.depends("last_error")
    @api.depends_context("lang")
    def _compute_customer_issue(self):
        from ..customer_presentation import customer_error_message
        for record in self:
            record.customer_issue = customer_error_message(record.env._, record.last_error)

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

    @api.model_create_multi
    def create(self, vals_list):
        # The worker trusts these source/policy identities after commit.
        # Branch administrators may recover existing work, but must not forge
        # work for arbitrary records through the ordinary model RPC surface.
        if not self.env.is_superuser():
            raise AccessError(_("Print intents must be created by an authorized business event."))
        return super().create(vals_list)

    def write(self, vals):
        if set(vals).intersection({
            "company_id", "intent_key", "policy_id", "res_model", "res_id", "event_type",
        }) and not self.env.is_superuser():
            raise AccessError(_("Print intent source and policy may only be changed by the trusted print service."))
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
                    # v3: the recovery-context escape is superuser-gated, mirroring
                    # the print config sync gate. RPC context is
                    # client-controllable, and no in-tree code sets this key
                    # (the cron recovers leases via _claim_intent and direct
                    # SQL, not through write()), so a group_system RPC caller
                    # must not be able to unclaim another worker's intent and
                    # get it re-dispatched. Server-side superuser code keeps
                    # the escape.
                    if record.status == "claimed" and target == "pending":
                        if not (self.env.is_superuser() and self.env.context.get("allow_lease_recovery")) and not (
                            vals.get("claim_token") == record.claim_token and record.claim_token
                        ):
                            raise ValidationError(
                                _("Transition from 'claimed' to 'pending' requires valid claim ownership or lease recovery context.")
                            )
        return super().write(vals)

    @api.model
    @api.private
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
            try:
                now = db_now_utc(target_cr)
                stale_threshold = now - datetime.timedelta(minutes=5)
                target_cr.execute("""
                    UPDATE print_gateway_intent
                    SET status = 'claimed', claimed_at = %s, claim_token = %s, attempts = attempts + 1
                    WHERE id = %s AND (
                        (status = 'pending' AND attempts < max_attempts AND (next_retry_at IS NULL OR next_retry_at <= %s)) OR
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
    def _finalize_route_failure(cls, env, intent_id, claim_token, error):
        """Persist routing/setup failures even when the routing cursor is aborted.

        An unexpected failure before route_intent() must not strand a claimed
        intent until the five-minute recovery lease expires. Re-read retry
        budget under a fresh cursor and keep the claim-token fencing check:
        a superseded worker must never modify the current worker's result.
        """
        if not claim_token:
            return False
        failure_cr = None
        try:
            failure_cr = env.registry.cursor()
            failure_cr.execute("""
                SELECT attempts, max_attempts
                  FROM print_gateway_intent
                 WHERE id = %s AND status = 'claimed' AND claim_token = %s
            """, (intent_id, claim_token))
            attempt_row = failure_cr.fetchone()
            if not attempt_row:
                _logger.warning("Cannot record failure for intent %s: claim was superseded.", intent_id)
                return False
            attempts, max_attempts = attempt_row
            next_retry = None
            if attempts < max_attempts:
                # The 300s maximum is reached at six attempts. Clamp the
                # exponent BEFORE pow: a corrupted/legacy attempt count must
                # never allocate an arbitrarily large integer to compute retry.
                delay_sec = min(300, 15 * (2 ** min(max(0, attempts - 1), 5)))
                next_retry = db_now_utc(failure_cr) + datetime.timedelta(seconds=delay_sec)
            finalized = cls._finalize_intent_state(
                env, intent_id, claim_token,
                status="failed" if attempts >= max_attempts else "pending",
                last_error=(str(error) or type(error).__name__)[:4096],
                next_retry_at=next_retry,
                cr=failure_cr,
            )
            if finalized:
                failure_cr.commit()
            return finalized
        except Exception:
            _logger.exception("Failed to persist routing error for print intent %s", intent_id)
            return False
        finally:
            if failure_cr is not None:
                failure_cr.close()

    @classmethod
    def _execute_dispatched_route(cls, env, intent_id, res_model, res_id, claim_token):
        """Execute network/gateway dispatch using an already acquired claim_token."""
        if not claim_token:
            return
        cr = None
        try:
            cr = env.registry.cursor()
            new_env = api.Environment(cr, env.uid, dict(env.context))
            intent = new_env["print_gateway.intent"].browse(intent_id).exists()
            if not intent or intent.claim_token != claim_token:
                _logger.warning("Intent %s claim token mismatch before routing; skipping.", intent_id)
                return
            # Source record rules may hide a branch document when the cron
            # user's default company is its parent/root. Use the ORIGINAL
            # persisted intent company *before* looking up the source.
            # Environment is callable with context= on Odoo; it has no
            # with_context(). The framework enforces allowed-company access.
            captured_company = intent.company_id
            if captured_company and captured_company.id != new_env.company.id:
                new_env = new_env(context=dict(new_env.context, allowed_company_ids=[captured_company.id]))
                intent = intent.with_env(new_env)
            record = new_env[res_model].browse(res_id).exists()
            if not record:
                cls._finalize_intent_state(
                    env, intent_id, claim_token,
                    status="skipped",
                    last_error="Source record no longer exists or is no longer accessible in its original company",
                )
                return
            # Never re-scope a captured print intent to a record that was
            # later moved into another company: that would send old business
            # data to a different branch's printer. Require explicit review.
            record_company = record.company_id if hasattr(record, "company_id") else False
            if captured_company and record_company and record_company.id != captured_company.id:
                cls._finalize_intent_state(
                    env, intent_id, claim_token,
                    status="skipped",
                    last_error="PRINT_SOURCE_COMPANY_CHANGED: Source record company changed after intent capture; printing was not sent",
                )
                return
            # The intent was captured against one authorized rule. Admins may
            # disable, re-scope, or edit a rule while queued work waits for the
            # cron: never print that old business event under a different
            # model/event/filter or a now-disabled rule.
            policy = intent.policy_id
            # The Odoo postcommit callback or recovery cron can run long
            # after this event was captured. Rechecking active/model/filter
            # alone is insufficient: a report, printer, protocol or raw
            # template may have changed without altering those fields.
            # In that case do not reinterpret an old event under a new route.
            captured_at = intent.create_date
            rule_changed_after_capture = bool(
                captured_at and policy and (
                    (policy.write_date and policy.write_date > captured_at)
                    or (policy.binding_id and policy.binding_id.write_date
                        and policy.binding_id.write_date > captured_at)
                )
            )
            if (not policy or not policy.active or rule_changed_after_capture
                    or policy.model_name != res_model or policy.event_type != intent.event_type):
                cls._finalize_intent_state(
                    env, intent_id, claim_token,
                    status="skipped",
                    last_error="PRINT_RULE_CHANGED: Print automation rule changed or was disabled after intent capture; no job was sent",
                )
                return
            with cr.savepoint():
                policy_still_matches = policy.matches_record(record)
            if not policy_still_matches:
                cls._finalize_intent_state(
                    env, intent_id, claim_token,
                    status="skipped",
                    last_error="PRINT_RULE_NOT_MATCHED: Print automation rule no longer matches the source; no job was sent",
                )
                return
            router = new_env["print_gateway.print_router"]
            try:
                # A failed ORM/SQL statement must not poison the transaction
                # used to calculate retry timing or inspect the claimed intent.
                with cr.savepoint():
                    route_res = router.route_intent(intent, record)
                    # A transport admission response is not a completed durable
                    # route. Only an actual committed outbox ID can terminalize
                    # this intent as dispatched; otherwise keep it retryable.
                    if not (route_res and route_res.get("job_id")) and not (
                        route_res and route_res.get("status") in ("skipped", "no_action")
                    ):
                        raise ValueError("Policy routing returned no durable outbox job or explicit skip")
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
            except Exception as exc:
                _logger.warning("Failed to route print intent %s for %s(%s): %s", intent.intent_key[:12], res_model, res_id, exc)
                cls._finalize_route_failure(env, intent_id, claim_token, exc)
        except Exception as exc:
            _logger.exception("Error preparing print intent %s for dispatch", intent_id)
            cls._finalize_route_failure(env, intent_id, claim_token, exc)
        finally:
            if cr is not None:
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
        self.check_access("write")
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
                (status = 'pending' AND attempts < max_attempts AND (next_retry_at IS NULL OR next_retry_at <= %s))
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
                self.env.cr.execute("""
                    UPDATE print_gateway_intent
                       SET status = 'failed', claimed_at = NULL, claim_token = NULL,
                           next_retry_at = NULL,
                           last_error = CASE
                               WHEN NULLIF(last_error, '') IS NULL THEN %s
                               ELSE last_error || E'\\nFinal dispatch lease expired; inspect Print Activity before re-arming.'
                           END,
                           write_date = NOW() AT TIME ZONE 'UTC'
                     WHERE id = %s AND status = 'claimed' AND attempts >= max_attempts
                       AND claim_token IS NOT DISTINCT FROM %s
                       AND (claimed_at IS NULL OR claimed_at <= %s)
                    RETURNING id
                """, ("Dispatch lease expired after the final attempt; manual operator re-arm required.",
                      candidate.id, candidate.claim_token or None, stale_threshold))
                recovered = bool(self.env.cr.fetchone())
                candidate.invalidate_recordset()
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
