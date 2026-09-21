"""Activation-sync robustness contract: the "Syncing" state must be bounded.

Root cause this locks in place: a pending activation sync used to be able to
persist forever as "Syncing" when every transport attempt died without
recording an outcome (unexpected post-commit crash, cron not running, or an
unhandled exception class). The contract now requires, at the source level:

1. A revision-bound staleness fence: pending_sync_started_at is stamped when a
   revision starts awaiting the Gateway and cleared when an outcome lands; the
   stored gateway_sync_state escalates to "attention" once
   now() - pending_sync_started_at exceeds _SYNC_PENDING_STALE_AFTER_SECONDS.
   The fence must NOT depend on write_date: any unrelated write moves it and
   would postpone stale detection while the same revision stays unconfirmed.
2. No silent death: the post-commit runner and both cron reconciliation legs
   catch unexpected exceptions, log the traceback via _logger.exception, and
   persist a POSTCOMMIT_ERROR / CRON_ERROR sync result through a fresh cursor.
3. A synchronous operator recovery path: action_retry_enabled_sync, wired as
   a form button visible exactly when the state is syncing or attention, that
   reads the fenced revision fresh at trigger time (same fence as the cron).
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "odoo_addons" / "print_gateway"


def read(rel):
    return (ADDON / rel).read_text(encoding="utf-8")


def test_syncing_state_is_time_bounded_by_a_revision_bound_timestamp():
    source = read("models/gateway_config.py")
    assert "_SYNC_PENDING_STALE_AFTER_SECONDS = 300" in source
    # Explicit pending bookkeeping fields exist and are the fence inputs.
    assert "pending_sync_revision = fields.Integer(" in source
    assert "pending_sync_started_at = fields.Datetime(" in source
    # The compute must NOT depend on write_date: record activity would
    # postpone stale detection. It must read the pending start timestamp.
    depends_idx = source.index('"last_enabled_sync_revision",')
    depends_tail = source[depends_idx:source.index("def _compute_gateway_sync_state")]
    assert '"write_date",' not in depends_tail
    assert '"pending_sync_started_at",' in depends_tail
    compute_idx = source.index("def _compute_gateway_sync_state")
    compute_end = source.index("@api.constrains", compute_idx)
    compute_body = source[compute_idx:compute_end]
    assert "pending_sync_started_at" in compute_body
    assert "self._SYNC_PENDING_STALE_AFTER_SECONDS" in compute_body
    assert "self._pending_stale_message()" in compute_body
    # The escalation message names the timeout and the recovery actions.
    helper_idx = source.index("def _pending_stale_message")
    helper = source[helper_idx:helper_idx + 400]
    assert "Retry Sync" in helper
    assert "verify Gateway connectivity" in helper


def test_pending_bookkeeping_is_stamped_on_every_revision_bump_and_cleared_on_success():
    source = read("models/gateway_config.py")
    # Enable/URL bumps stamp both fields in the technical write.
    assert '"pending_sync_revision": new_revision,' in source
    assert '"pending_sync_started_at": fields.Datetime.now(),' in source
    # Credential rotation/restore bumps stamp as well.
    assert '"pending_sync_revision": before_revision[record.id] + 1,' in source
    # Creation stamps the initial pending revision.
    assert 'vals["pending_sync_revision"] = int(vals.get("enabled_sync_revision") or 0)' in source
    # Recording a successful outcome ends the staleness window.
    assert '"pending_sync_revision": -1,' in source
    assert '"pending_sync_started_at": False,' in source


def test_migration_backfills_rows_pending_before_the_fence_existed():
    migration = read("migrations/19.0.2.6.0/post-migrate.py")
    assert "pending_sync_started_at = write_date" in migration
    assert "enabled_sync_revision != COALESCE(last_enabled_sync_revision, -1)" in migration
    assert "pending_sync_started_at IS NULL" in migration


def test_postcommit_runner_cannot_die_silently():
    source = read("models/gateway_config.py")
    runner_idx = source.index("def _run_postcommit_enabled_sync")
    runner_end = source.index("def _reconcile_remote_enabled_revision", runner_idx)
    runner = source[runner_idx:runner_end]
    assert "except Exception" in runner
    assert "POSTCOMMIT_ERROR" in runner
    # Diagnostic context: the traceback itself must reach the Odoo log.
    assert "_logger.exception(" in runner
    assert "_persist_enabled_sync_result" in runner


def test_cron_legs_cannot_die_silently():
    source = read("models/gateway_config.py")
    cron_idx = source.index("def cron_sync_enabled_state(self):")
    cron_body = source[cron_idx:]
    assert cron_body.count("except Exception") >= 2
    assert "CRON_ERROR: unexpected shutdown reconciliation failure" in cron_body
    assert "CRON_ERROR: unexpected activation reconciliation failure" in cron_body
    assert cron_body.count("_logger.exception(") >= 2


def test_pending_disable_credentials_is_the_single_source_for_pending_state():
    source = read("models/gateway_config.py")
    assert "def _pending_disable_credentials" in source
    # Both the queue and the cron must resolve pending state through the
    # shared helper instead of duplicating the incomplete-state guard.
    assert source.count('"Gateway endpoint shutdown/migration state is incomplete') == 1


def test_manual_retry_reads_the_fenced_revision_fresh_and_reuses_the_hardened_runner():
    source = read("models/gateway_config.py")
    action_idx = source.index("def action_retry_enabled_sync")
    action_body = source[action_idx:source.index("def action_test_connection", action_idx)]
    assert "_check_admin" in action_body
    # Fence discipline: invalidate the cached revision, read it at trigger
    # time, and let the shared reconciliation cursor arbitrate races with a
    # concurrent cron/post-commit sync. No manual cr.commit() inside the RPC.
    assert 'invalidate_recordset(["enabled_sync_revision", "enabled"])' in action_body
    assert "revision = int(self.enabled_sync_revision or 0)" in action_body
    assert "_run_postcommit_enabled_sync(" in action_body
    assert ".commit(" not in action_body

    view = read("views/gateway_config_views.xml")
    button_idx = view.index('name="action_retry_enabled_sync"')
    button_tail = view[button_idx:min(len(view), button_idx + 200)]
    assert 'invisible="gateway_sync_state not in (\'syncing\', \'attention\')"' in button_tail
