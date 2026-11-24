"""A stale, never-admitted POS operation must not print after billing resumes."""
from datetime import datetime, timedelta, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "odoo_addons/print_gateway/pos_retry_policy.py"
spec = spec_from_file_location("pos_retry_policy", MODULE)
module = module_from_spec(spec)
spec.loader.exec_module(module)

NOW = datetime(2026, 10, 27, 20, 0, 0)

@pytest.mark.parametrize("source,kind", [("pos.order", "receipt"), ("pos.order", "kitchen"), ("pos.session", "receipt")])
def test_old_pos_outbox_needs_explicit_reprint(source, kind):
    assert module.is_stale_pos_operation(source, kind, NOW - timedelta(minutes=31), NOW) is True

@pytest.mark.parametrize("source", ["pos.order", "pos.session"])
@pytest.mark.parametrize("kind", ["pos_receipt", "pos_kitchen"])
def test_legacy_pos_document_aliases_never_autoprint_after_billing_recovery(source, kind):
    # Legacy persisted document types must be as time-sensitive as current
    # receipt/kitchen records. A renewed plan must not print a day-old ticket.
    assert module.is_stale_pos_operation(source, kind, NOW - timedelta(days=1), NOW) is True
    assert module.is_stale_pos_operation(source, kind, NOW - timedelta(minutes=4), NOW) is False


@pytest.mark.parametrize("source,kind", [("account.move", "invoice"), ("pos.order", "label"), ("stock.picking", "receipt")])
def test_other_old_documents_are_not_blocked(source, kind):
    assert module.is_stale_pos_operation(source, kind, NOW - timedelta(days=9), NOW) is False

def test_fresh_pos_and_accepted_remote_jobs_remain_eligible():
    assert module.is_stale_pos_operation("pos.order", "receipt", NOW - timedelta(minutes=29), NOW) is False
    assert module.is_stale_pos_operation("pos.order", "receipt", NOW - timedelta(minutes=30), NOW) is True

def test_unknown_creation_time_fails_closed_for_old_pos():
    assert module.is_stale_pos_operation("pos.order", "receipt", None, NOW) is True
    assert module.is_stale_pos_operation("account.move", "invoice", None, NOW) is False

def test_timezone_aware_timestamps_use_absolute_utc():
    created = datetime(2026, 10, 27, 22, 15, tzinfo=timezone(timedelta(hours=3)))
    now = datetime(2026, 10, 27, 20, 0, tzinfo=timezone.utc)
    assert module.is_stale_pos_operation("pos.order", "receipt", created, now) is True
