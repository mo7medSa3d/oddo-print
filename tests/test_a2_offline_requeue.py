"""A-2: transient printer/agent-unavailable 503 must requeue, not terminally fail."""
from pathlib import Path

ADDON = Path(__file__).resolve().parent.parent / "odoo_addons" / "print_gateway"


def test_offline_503_requeues_with_backoff():
    src = (ADDON / "models" / "print_job.py").read_text(encoding="utf-8")
    marker = 'if reject_code in ("PRINTER_OFFLINE", "PRINTER_UNAVAILABLE", "AGENT_UNAVAILABLE"):'
    assert marker in src
    block = src[src.index(marker):]
    block = block[: block.index("# Any other 503")]
    # Must not unconditionally terminally fail a transient offline: requeue
    # with retry, terminalizing only after bounded attempts.
    assert '"failed" if terminal else "queued"' in block, "offline 503 must requeue, terminalizing only when bounded"
    assert "next_attempt >= 5" in block, "offline 503 must bound attempts"
    assert "next_retry_at" in block, "offline 503 must schedule backoff"
