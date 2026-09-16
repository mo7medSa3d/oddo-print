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


def test_gateway_config_preserves_revoked_status_on_401():
    source = read("models/gateway_config.py")
    assert '"last_test_status": "revoked"' in source
    assert 'message = _("API Key has been revoked or deleted from the Gateway.' in source
    revoked_at = source.index('"last_test_status": "revoked"')
    return_at = source.index('"tag": "display_notification"', revoked_at)
    assert '"type": "warning"' in source[revoked_at:return_at + 1000]
    assert 'raise ValidationError(message)' not in source[revoked_at:return_at + 1000]


def test_gateway_api_key_is_admin_only_and_not_exportable():
    source = read("models/gateway_config.py")
    field_start = source.index("gateway_api_key = fields.Char(")
    field_end = source.index(")", field_start) + 1
    field = source[field_start:field_end]
    assert "copy=False" in field
    assert "exportable=False" in field
    assert 'groups="base.group_system"' in field


def test_gateway_401_is_checked_before_response_json_parsing():
    source = read("models/gateway_config.py")
    status_idx = source.index("if response.status_code == 401:")
    json_idx = source.index("body = response.json() if response.content else {}")
    assert status_idx < json_idx


def test_gateway_api_key_view_is_password_masked_and_system_admin_only():
    source = read("views/gateway_config_views.xml")
    field_idx = source.index('field name="gateway_api_key"')
    field_tail = source[field_idx:field_idx + 280]
    assert 'password="True"' in field_tail
    button_idx = source.index('name="action_clear_api_key"')
    button_tail = source[button_idx:button_idx + 220]
    assert 'groups="base.group_system"' in button_tail


def test_gateway_http_requires_explicit_development_opt_in():
    source = read("models/gateway_config.py")
    assert 'scheme == "http"' in source
    assert 'ODOO_PRINT_GATEWAY_ALLOW_INSECURE_HTTP' in source
    assert "Plain HTTP is allowed only for explicitly opted-in isolated development." in source
