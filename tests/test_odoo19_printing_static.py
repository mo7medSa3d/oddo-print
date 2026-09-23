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
    assert 'message = _("The Gateway rejected the API key.' in source
    revoked_at = source.index('"last_test_status": "revoked"')
    return_at = source.index('"tag": "display_notification"', revoked_at)
    assert '"type": "warning"' in source[revoked_at:return_at + 1000]
    assert 'raise ValidationError(message)' not in source[revoked_at:return_at + 1000]
    assert 'if response.status_code == 403:' in source
    assert 'Gateway workspace is not available for printing.' in source


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
    assert 'groups="base.group_system"' in (read("models/gateway_config.py")[
        read("models/gateway_config.py").index("gateway_api_key = fields.Char("):
        read("models/gateway_config.py").index("gateway_api_key = fields.Char(") + 500
    ])
    form_start = source.index('id="view_print_gateway_config_form"')
    form_end = source.index('<record id="view_print_gateway_config_search"', form_start)
    assert 'name="action_clear_api_key"' not in source[form_start:form_end]


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
    assert "Gateway endpoint shutdown/migration state is incomplete" in source
    assert "FOR UPDATE" in source
    assert "invalidate_recordset" in source
    assert "def _complete_gateway_migration" in source
    assert "if synced and pending_disable" in source
    assert "acknowledged_enabled is enabled" in source
    assert "acknowledged_revision == revision" in source
    assert "config._complete_gateway_migration(revision)" in source


def test_gateway_queue_admission_allows_active_agent_when_heartbeat_is_stale():
    source = (ROOT / "src" / "lib" / "print-job-service.ts").read_text(encoding="utf-8")
    service_start = source.index("export async function createPrintJobForPrinter")
    service = source[service_start:]
    assert 'ownerAgent.lifecycle !== "active"' in service
    assert "isAgentAvailableForJob(ownerAgent)" not in service
    assert 'owner.agent_status !== "online"' not in service
    assert "owner.agent_last_seen_at" not in service

def test_gateway_config_form_is_setup_only_without_internal_recovery_buttons():
    source = read("views/gateway_config_views.xml")
    form_start = source.index('id="view_print_gateway_config_form"')
    form_end = source.index('<record id="view_print_gateway_config_search"', form_start)
    form = source[form_start:form_end]
    assert '<header/>' in form
    for action in (
        'name="action_retry_enabled_sync"',
        'name="action_reset_stale_sync_state"',
        'name="action_open_pairing_wizard"',
        'name="action_open_runtime_assignments"',
        'name="action_clear_api_key"',
    ):
        assert action not in form
    assert 'field name="gateway_url"' in form
    assert 'field name="gateway_api_key"' in form
    assert 'field name="enabled" widget="boolean_toggle"' in form
    assert 'field name="last_test_status"' in form
    assert 'field name="gateway_sync_state"' not in form
    assert 'field name="gateway_sync_message"' not in form
    assert "Odoo owns business context and print intent." not in form


def test_gateway_connection_status_uses_simple_operator_labels():
    source = read("models/gateway_config.py")
    field_idx = source.index("last_test_status = fields.Selection(")
    field = source[field_idx:source.index("gateway_sync_state = fields.Selection(", field_idx)]
    assert '("success", "Connected")' in field
    assert '("failed", "Not connected")' in field
    assert '("revoked", "API key revoked")' in field
    assert '("draft", "Not configured")' in field


def test_gateway_sync_state_does_not_report_active_after_health_failure():
    source = read("models/gateway_config.py")
    compute_idx = source.index("def _compute_gateway_sync_state")
    compute_end = source.index("@api.constrains", compute_idx)
    compute = source[compute_idx:compute_end]
    failed_idx = compute.index('if record.last_test_status == "failed":')
    active_idx = compute.index('if record.enabled:', failed_idx)
    assert 'record.gateway_sync_state = "attention"' in compute[failed_idx:active_idx]
    assert 'record.gateway_sync_state = "active"' in compute[active_idx:]


def test_gateway_config_auto_syncs_after_api_key_save():
    source = (ADDON / "static" / "src" / "js" / "gateway_config_auto_sync.js").read_text(encoding="utf-8")
    manifest = (ADDON / "__manifest__.py").read_text(encoding="utf-8")
    assert "gateway_config_auto_sync.js" in manifest
    assert 'this.model.root.resModel !== "print_gateway.gateway_config"' in source
    assert 'hasOwnProperty.call(changes, "gateway_api_key")' in source
    assert 'this.model.root.data.gateway_api_key' in source
    assert 'this.orm.call(' in source
    assert '"print_gateway.gateway_config"' in source
    assert '"action_test_connection"' in source
    assert 'await this.model.load({ resId });' in source


def test_gateway_config_auto_sync_uses_persisted_res_id_never_datapoint_id():
    """Regression: 'Invalid ids list: datapoint_27' crashed the config form.

    In Odoo 19 every DataPoint's ``.id`` is a client-side identifier
    (``getId("datapoint")`` in web/static/src/model/relational_model/
    datapoint.js), never the database id. Record._save() commits the real
    resId into the config before the onRecordSaved hook runs, so the hook
    must address the record through ``this.model.root.resId`` — the same
    accessor the stock FormController uses in onRecordSaved. The hook used
    to send ``record.id`` ("datapoint_N") to action_test_connection /
    action_retry_enabled_sync (server-side browse failure: the sync never
    ran and the banner stayed "Syncing") and to ``model.load({resId: ...})``
    (client crash "Invalid ids list: datapoint_N" — uncaught promise error
    on the form).
    """
    source = (ADDON / "static" / "src" / "js" / "gateway_config_auto_sync.js").read_text(encoding="utf-8")
    # The persisted database id accessor, exactly as the stock web client
    # reads it inside onRecordSaved.
    assert "const resId = record.resId;" in source
    # The RPC and the reload address the persisted record, never the
    # client-side datapoint id.
    assert "[[resId]]," in source
    assert "record.id" not in source
    # A falsy resId (record not persisted) must bail out before any RPC.
    guard_index = source.index("if (!resId || !this.model.root.data.gateway_api_key)")
    assert guard_index < source.index('"action_test_connection"')
    assert guard_index < source.index('"action_retry_enabled_sync"')


def test_gateway_config_auto_syncs_activation_toggle_without_manual_refresh():
    """Replacing a key or toggling activation must converge on screen by itself.

    Contract: the form-controller hook also fires for the "enabled" toggle,
    pushes the fenced revision through action_retry_enabled_sync, and reloads
    the record from persisted state in every path, so the operator never has
    to refresh manually and the "Syncing" banner cannot be the last thing
    shown after a successful save.
    """
    source = (ADDON / "static" / "src" / "js" / "gateway_config_auto_sync.js").read_text(encoding="utf-8")
    assert 'hasOwnProperty.call(changes, "enabled")' in source
    assert '"action_retry_enabled_sync"' in source
    # The credential guard keeps the toggle from firing without a stored key.
    assert source.index('this.model.root.data.gateway_api_key') < source.index('"action_retry_enabled_sync"')
    # Exactly one reload path: every trigger converges through the same
    # finally block reading the authoritative persisted state.
    assert source.count('await this.model.load({ resId });') == 1



def test_odoo_integration_guide_matches_current_module_architecture():
    guide = (ROOT / "ODOO_INTEGRATION.md").read_text(encoding="utf-8")
    assert "Version: 19.0.2.8.0" in guide
    assert "report_download_override.py" not in guide
    assert "report_interceptor.js" in guide
    assert "runtime_agent_assignment" in guide
    assert "company-wide assignment inherited by its branches" in guide


def test_critical_addon_models_have_no_duplicate_methods():
    import ast

    for rel in (
        "models/binding.py",
        "models/runtime_assignment.py",
        "models/print_router.py",
        "controllers/runtime_printers.py",
    ):
        source = read(rel)
        tree = ast.parse(source, filename=rel)
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                methods = [
                    child.name
                    for child in node.body
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                ]
                duplicates = sorted({name for name in methods if methods.count(name) > 1})
                assert not duplicates, f"{rel}::{node.name} defines duplicate methods: {duplicates}"


def test_pair_agent_wizard_has_single_agent_input():
    source = read("models/gateway_config.py")
    view = read("views/gateway_config_views.xml")
    assert source.count("pairing_code") == 0
    assert "agent_id = fields.Char(" in source
    assert 'field name="agent_id"' in view
    assert 'gateway_runtime_agent_picker' in view
