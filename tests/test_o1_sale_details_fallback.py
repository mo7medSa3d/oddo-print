"""O-1: Sale Details must preserve native fallback when enabled but unbound."""
from pathlib import Path

ADDON = Path(__file__).resolve().parent.parent / "odoo_addons" / "print_gateway"


def test_sale_details_native_falls_back_to_super():
    src = (ADDON / "controllers" / "pos.py").read_text(encoding="utf-8")
    assert "super().print_sale_details" in src, (
        "native path must delegate to Odoo instead of returning 422"
    )
    native_block = src[src.index("if result.get('native')"):]
    native_block = native_block[: native_block.index("response = request.make_response")]
    assert "gateway_binding_missing" not in native_block, (
        "unbound Sale Details must not hard-error when gateway is enabled"
    )
