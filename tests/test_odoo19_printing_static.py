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


def test_automatic_policy_hooks_use_root_and_exact_branch_resolver():
    policy = read("models/print_policy.py")
    assert "root_company = record_company.parent_id or record_company" in policy
    assert "branch = record_company if record_company.parent_id else False" in policy
    assert '("company_id", "=", root_company.id)' in policy
    assert '("branch_id", "in", [False, branch.id] if branch else [False])' in policy
    for hook in ("models/account_move.py", "models/stock_picking.py", "models/pos_order.py"):
        source = read(hook)
        assert "resolve_for_record(" in source
        assert "policy_model.search([" not in source


def test_odoo19_report_download_controller_is_left_native():
    controllers = read("controllers/__init__.py")
    assert "report_download_override" not in controllers
    assert not (ADDON / "controllers" / "report_download_override.py").exists()
    assert "report_interceptor.js" in read("__manifest__.py")
    assert "super().report_download" not in "\n".join(
        path.read_text(encoding="utf-8") for path in (ADDON / "controllers").glob("*.py")
    )


def test_lower_priority_explicit_binding_is_exact_and_separate_policy_targets_do_not_collapse():
    router = read("models/print_router.py")
    binding = read("models/binding.py")
    policy = read("models/print_policy.py")
    assert "explicit_binding=policy.binding_id or None" in router
    assert "binding_model.resolve_explicit(" in router
    assert "return binding" in binding[binding.index("def resolve_explicit"):binding.index("def find_for")]
    assert ".find_for(" not in binding[binding.index("def resolve_explicit"):binding.index("def find_for")]
    assert "binding_id = route.get(\"binding_id\") or False" in policy
    for hook in ("models/account_move.py", "models/stock_picking.py", "models/pos_order.py"):
        source = read(hook)
        assert "policy.effective_target_key(" in source
        assert "policy.binding_id.id if policy.binding_id else False" not in source


def test_branch_owned_destinations_require_branch_specific_bindings():
    binding = read("models/binding.py")
    fallback = binding[binding.index("def find_for"):binding.index("def dispatch_report_action")]
    assert "if destination_company == branch:" in fallback
    assert "return self.browse()" in fallback


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


def test_gateway_url_change_durably_disables_previous_endpoint_before_new_sync():
    source = read("models/gateway_config.py")
    assert "pending_disable_gateway_url" in source
    assert "pending_disable_gateway_api_key" in source
    assert "pending_disable_revision" in source
    assert "def _sync_pending_gateway_disable" in source
    assert 'body.get("enabled") is not False' in source
    assert "url_migrations" in source
    assert "new_revision = before_revision[record.id] + 1" in source
    assert "previous Gateway endpoint has been successfully disabled" in source
    assert "def _run_postcommit_enabled_sync" in source
    assert "if not self._sync_pending_gateway_disable" in source
    assert "self._sync_enabled_state_to_gateway(" in source
    assert '"|"' in source
    assert '"pending_disable_gateway_url", "!="' in source
    assert "def create(self, vals_list):" in source
    assert "Gateway URL migration state is incomplete" in source
    assert "FOR UPDATE" in source
    assert "invalidate_recordset" in source
    assert "def _complete_gateway_migration" in source
    assert "if synced and pending_disable" in source
    assert "acknowledged_enabled is not enabled" in source
    assert "acknowledged_revision != revision" in source


def test_gateway_queue_admission_allows_active_agent_when_heartbeat_is_stale():
    source = (ROOT / "src" / "lib" / "print-job-service.ts").read_text(encoding="utf-8")
    service_start = source.index("export async function createPrintJobForPrinter")
    service = source[service_start:]
    assert 'ownerAgent.lifecycle !== "active"' in service
    assert "isAgentAvailableForJob(ownerAgent)" not in service
    assert 'owner.agent_status !== "online"' not in service
    assert "owner.agent_last_seen_at" not in service
