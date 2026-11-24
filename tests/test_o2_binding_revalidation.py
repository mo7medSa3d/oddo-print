"""O-2: persist must revalidate the selected binding on its fresh cursor."""
from pathlib import Path

ROUTER = Path(__file__).resolve().parent.parent / "odoo_addons" / "print_gateway" / "models" / "print_router.py"


def test_persist_revalidates_binding():
    src = ROUTER.read_text(encoding="utf-8")
    persist = src[src.index("def _persist_durable_job"):]
    persist = persist[: persist.index("def _durable_submission_outcome")]
    assert '"binding"' in persist, "persist must carry the selected binding"
    assert "selected_binding.enabled" in persist or "binding.enabled" in persist, "persist must check binding enabled"
    assert "is_agent_assigned" in persist, "persist must recheck agent assignment"
    assert "repointed" in persist, "persist must detect printer repointing"
    assert 'durable_values.pop("binding"' in persist, "binding must not leak into create_operation"


def test_submit_routes_pass_binding():
    src = ROUTER.read_text(encoding="utf-8")
    assert src.count('"binding": route.get("binding")') >= 1
    assert '"binding": target_binding' in src
