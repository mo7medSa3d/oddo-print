from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "odoo_addons" / "print_gateway"


def read(rel):
    return (ADDON / rel).read_text(encoding="utf-8")


def test_pos_router_uses_current_odoo19_pos_store_service_path():
    source = read("static/src/js/pos_print_router.js")
    assert 'from "@point_of_sale/app/services/pos_store"' in source
    assert "printReceipt" in source
    assert "printOrderChanges" in source


def test_gateway_mode_never_falls_back_to_core_printer_for_physical_pos_paths():
    source = read("static/src/js/pos_print_router.js")
    receipt_start = source.index("async printReceipt")
    receipt_end = source.index("getOrderData", receipt_start)
    receipt = source[receipt_start:receipt_end]
    assert "gatewayEnabled !== true" in receipt
    assert "return super.printReceipt" in receipt
    assert "action_print_gateway_receipt" in receipt
    kitchen = source[source.index("async printOrderChanges"):]
    assert "action_print_gateway_kitchen" in kitchen
    assert "return super.printOrderChanges(data, printer)" in kitchen


def test_project_does_not_add_parallel_browser_iot_or_epos_print_path():
    files = list((ADDON / "static").rglob("*.js")) + list((ADDON / "controllers").rglob("*.py"))
    joined = "\n".join(p.read_text(encoding="utf-8") for p in files)
    assert "window.print(" not in joined
    assert "hardware_proxy" not in joined
    assert "iot_longpolling" not in joined
    assert "ePOS" not in joined


def test_report_controller_remains_fail_closed_for_bound_report_errors():
    source = read("controllers/report_download_override.py")
    assert "gateway_dispatch_failed" in source
    assert "mixed_scope_batch" in source
    assert "return super().report_download" in source


def test_company_gateway_secret_is_server_side_only_in_runtime_controllers():
    source = read("controllers/runtime_printers.py")
    assert "gateway_api_key" not in source
    assert "_gateway_headers" in source
