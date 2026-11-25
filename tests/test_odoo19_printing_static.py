import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "odoo_addons19" / "print_gateway"


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


def test_gateway_pos_receipt_and_kitchen_use_native_business_destinations():
    binding = read("models/binding.py")
    view = read("views/binding_views.xml")
    pos = read("models/pos_order.py")
    router = read("models/print_router.py")
    js = read("static/src/js/pos_print_router.js")

    assert '("pos", "POS Receipt")' in binding
    assert '("pos_printer", "POS Kitchen / Preparation")' in binding
    assert 'record.document_type = "receipt"' in binding
    assert 'record.document_type = "kitchen"' in binding
    assert 'destination = record.report_id or record.destination_report_id' in binding
    assert 'name="destination_pos_printer_id" string="Odoo Preparation Printer"' in view
    assert 'invisible="destination_type != \'pos_printer\'"' in view
    assert 'name="destination_pos_config_id" string="POS Shop"' in view
    assert 'getattr(config, "preparation_printer_ids", None)' in binding
    assert "config.printer_ids" in binding
    assert "Odoo Preparation Printer must belong to an Odoo POS Preparation Printer configuration." in binding
    assert 'action_print_gateway_kitchen(self, image, reprint=False, operation_id=None, pos_printer_id=None, geometry_fingerprint=None)' in pos
    assert "def get_gateway_kitchen_routes(self):" in pos
    assert 'getattr(self.config_id, "preparation_printer_ids", None)' in pos
    assert "self.config_id.printer_ids" in pos
    assert "pos_printer_id" in pos
    assert "pos_printer=None" in router
    assert "explicit_destination = pos_printer" in router
    assert "get_gateway_kitchen_routes" in js
    assert "routeCategories" in js
    assert "missing_routes" in js
    assert "printers = this.unwatched.printers" in js
    assert "printers instanceof Set" in js
    assert "kitchen-retry-" in js
    assert "if (reprint || !orderChange.__gateway_print_id)" in js
    assert "return super.sendOrderInPreparation(order, opts)" in js

def test_project_does_not_add_parallel_browser_iot_or_epos_print_path():
    files = list((ADDON / "static").rglob("*.js")) + list((ADDON / "controllers").rglob("*.py"))
    joined = "\n".join(p.read_text(encoding="utf-8") for p in files)
    assert "window.print(" not in joined
    assert "hardware_proxy" not in joined
    assert "iot_longpolling" not in joined
    assert "ePOS" not in joined


def test_automatic_policy_dispatcher_owns_root_and_exact_branch_resolution():
    policy = read("models/print_policy.py")
    assert "root_company = record_company.parent_id or record_company" in policy
    assert "branch = record_company if record_company.parent_id else False" in policy
    assert '("company_id", "=", root_company.id)' in policy
    assert '("branch_id", "in", [False, branch.id] if branch else [False])' in policy
    assert "def resolve_for_record" in policy
    assert "def dispatch_for_record" in policy
    for hook in ("models/account_move.py", "models/stock_picking.py", "models/pos_order.py"):
        source = read(hook)
        assert "dispatch_for_record(" in source
        assert "resolve_for_record(" not in source
        assert "effective_target_key(" not in source
        assert "create_and_route(" not in source


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
    # The fan-out key must derive its binding from the RESOLVED route (so an
    # explicit binding is exact and separate policies never collapse into one
    # key), and key computation must not be able to abort dispatch: a routing
    # failure falls back to the declared binding instead of raising, otherwise
    # a cross-company automated print is silently skipped.
    assert 'route.get("binding_id") or False' in policy
    assert "def _policy_target_binding_id" in policy
    assert "def effective_target_key" in policy
    assert "def dispatch_for_record" in policy
    for hook in ("models/account_move.py", "models/stock_picking.py", "models/pos_order.py"):
        source = read(hook)
        assert "policy.effective_target_key(" not in source
        assert "policy.binding_id.id if policy.binding_id else False" not in source


def test_branch_owned_destinations_require_branch_specific_bindings():
    binding = read("models/binding.py")
    fallback = binding[binding.index("def find_for"):binding.index("def dispatch_report_action")]
    assert "if selected_branch is False and branch and destination_company == branch:" in fallback
    assert "return self.browse()" in fallback


def test_company_gateway_secret_is_server_side_only_in_runtime_controllers():
    source = read("controllers/runtime_printers.py")
    assert "gateway_api_key" not in source
    assert "cloud_api_key" not in source


def test_gateway_queue_admission_allows_active_agent_when_heartbeat_is_stale():
    assert not (ROOT / "src" / "lib" / "print-job-service.ts").exists()
    schema = (ROOT / "src" / "db" / "schema.ts").read_text(encoding="utf-8")
    assert 'pgTable("print_jobs"' not in schema
    assert 'pgTable("agents"' not in schema


def test_gateway_report_group_check_uses_odoo19_effective_groups():
    source = (ADDON / "models/binding.py").read_text(encoding="utf-8")
    assert "env.user.all_group_ids.ids" in source
    assert "env.user.groups_id.ids" not in source


def test_gateway_pos_receipt_keeps_nb_print_in_sync():
    source = (ADDON / "static/src/js/pos_print_router.js").read_text(encoding="utf-8")
    start = source.index("async printReceipt(")
    end = source.index("    getOrderData(", start)
    method = source[start:end]

    assert 'const writeResult = await gatewaySilentCall(' in method
    assert 'if (writeResult !== false)' in method
    assert 'currentOrder.nb_print = count;' in method
    assert method.index("await gatewaySilentCall") < method.index("currentOrder.nb_print = count;")



def test_gateway_sale_details_uses_odoo19_component_and_props():
    source = (ADDON / "static/src/js/pos_sale_details_router.js").read_text(encoding="utf-8")
    assert '"point_of_sale.SaleDetailsReport"' in source
    assert "renderToElement(" in source
    assert "date: formatDateTime(DateTime.now())" in source
    assert "pos: this.pos" in source
    assert "formatCurrency: this.pos.env.utils.formatCurrency" in source
    assert "ticketPrinter" not in source
    assert "generateSaleDetailsData" not in source
    assert "point_of_sale.pos_sale_details_receipt" not in source


def test_gateway_sale_details_only_falls_back_before_gateway_owns_the_print():
    source = (ADDON / "static/src/js/pos_sale_details_router.js").read_text(encoding="utf-8")
    assert source.count("return super.onClick();") == 3
    probe_catch = source.index("catch (probeError)")
    enabled_branch = source.index("if (enabled !== true)")
    sale_details_fetch = source.index("const saleDetails")
    assert probe_catch < source.index("return super.onClick();", probe_catch) < enabled_branch
    assert enabled_branch < source.index("return super.onClick();", enabled_branch) < sale_details_fetch
    catch_block = source[source.index("} catch (error)") :]
    assert "if (preDispatchFailure)" in catch_block
    post_dispatch_block = catch_block[catch_block.index("if (showGatewayBillingLimitDialog") :]
    assert "super.onClick" not in post_dispatch_block


def test_gateway_pos_sale_details_routes_as_pos_receipt_not_report_action():
    source = (ADDON / "models/print_router.py").read_text(encoding="utf-8")
    start = source.index("def route_pos_sale_details")
    end = source.index("def route_intent", start)
    method = source[start:end]
    assert 'document_type="receipt"' in method
    assert "explicit_destination=session.config_id" in method
    assert "report:point_of_sale.sale_details_report" not in method


def test_gateway_receipt_uses_odoo19_receipt_template():
    source = (ADDON / "static/src/js/pos_print_router.js").read_text(encoding="utf-8")
    assert 'renderToElement(receiptComponent.template || "point_of_sale.OrderReceipt", props)' in source
    assert '"point_of_sale.pos_order_receipt"' not in source
    assert 'const receiptComponent = pos.orderReceiptComponent || OrderReceipt' in source
    assert 'formatCurrency: pos.env' not in source
    assert 'data: typeof currentOrder.export_for_printing' not in source


def test_gateway_kitchen_uses_odoo19_preparation_receipt_template():
    source = (ADDON / "static/src/js/pos_print_router.js").read_text(encoding="utf-8")
    assert 'renderToElement("point_of_sale.OrderChangeReceipt", { data })' in source
    assert 'renderToElement("point_of_sale.pos_order_change_receipt", data)' not in source


def test_gateway_kitchen_uses_native_order_change_lifecycle():
    source = (ADDON / "static/src/js/pos_print_router.js").read_text(encoding="utf-8")
    start = source.index("async sendOrderInPreparation(order, opts = {})")
    end = source.index("async printChanges(", start)
    method = source[start:end]

    # The accepted snapshot, not the later live order, must be marked as
    # prepared. The actual-method JS behavior test exercises native Odoo 19
    # updateLastOrderChange() against that snapshot and concurrent edits.
    assert "preparationSnapshot = captureKitchenPreparationState(order);" in method
    assert "if (isPrinted && !reprint && hasChanges)" in method
    assert "consumeAcceptedKitchenSnapshot(order, preparationSnapshot);" in method
    assert "this.updateLastOrderChangeIfNoDevice(order, opts);" in method
    assert method.index("if (isPrinted && !reprint && hasChanges)") < method.index("consumeAcceptedKitchenSnapshot(order, preparationSnapshot);")
    helper = source[source.index("function consumeAcceptedKitchenSnapshot(order, snapshot)"):source.index("function consumeAcceptedKitchenSnapshot(order, snapshot)") + 1900]
    assert "order.updateLastOrderChange.call(snapshot);" in helper
    assert "order.updateLastOrderChange();" in helper  # deliberately bounded legacy-fixture fallback


def test_gateway_kitchen_does_not_consume_failed_changes():
    source = (ADDON / "static/src/js/pos_print_router.js").read_text(encoding="utf-8")
    method_start = source.index("async sendOrderInPreparation(order, opts = {})")
    method_end = source.index("async printChanges(", method_start)
    method = source[method_start:method_end]

    # A failed or explicitly reprinted ticket cannot consume a live edit.
    # The native no-device path is still present on the other branch.
    assert "if (isPrinted && !reprint && hasChanges)" in method
    assert "consumeAcceptedKitchenSnapshot(order, preparationSnapshot);" in method
    assert "else {\n                    this.updateLastOrderChangeIfNoDevice(order, opts);" in method
    assert "order.updateLastOrderChange();" not in method
    assert method.index("this.printChanges(") < method.index("consumeAcceptedKitchenSnapshot(order, preparationSnapshot);")

def test_gateway_kitchen_preserves_odoo19_post_print_sync():
    source = (ADDON / "static/src/js/pos_print_router.js").read_text(encoding="utf-8")
    method_start = source.index("async sendOrderInPreparation(order, opts = {})")
    method_end = source.index("async printChanges(", method_start)
    method = source[method_start:method_end]

    # Odoo 19's native sendOrderInPreparation() synchronizes the changed order
    # after printing unless a preparation display already owns synchronization.
    assert 'if (!this.models["pos.prep.display"]?.length)' in method
    assert 'await gatewaySync(this, { orders: [order] });' in method
    assert method.index("this.syncingOrders.delete(order.uuid)") < method.index(
        'await gatewaySync(this, { orders: [order] });'
    )



def test_odoo_integration_guide_matches_current_module_architecture():
    guide = (ROOT / "ODOO_INTEGRATION.md").read_text(encoding="utf-8")
    import ast
    manifest = ast.literal_eval((ADDON / "__manifest__.py").read_text(encoding="utf-8"))
    assert f"Version: {manifest['version']}" in guide
    assert "report_download_override.py" not in guide
    assert "report_interceptor.js" in guide
    assert "runtime_agent_assignment" in guide
    assert "a Company-only binding may use any Agent assigned to the Company or one of its direct child Branches" in guide


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


def test_agent_registration_pairing_uses_database_clock():
    # Direct mode deliberately moved Agent registration from the Next.js
    # control plane into Odoo's local PostgreSQL-backed controller. Keep the
    # pairing-expiry contract pinned to the actual request handler.
    agent_model = read("models/agent.py")
    register = read("controllers/agent_api.py")
    assert "pairing_expires_at = fields.Datetime" in agent_model
    assert "pairing_code_hash = fields.Char" in agent_model
    assert '@http.route(["/print_gateway/agent/register", "/api/agent/register"]' in register
    assert "pairing_expires_at >= (clock_timestamp() AT TIME ZONE 'UTC')" in register
    assert "FOR UPDATE" in register
    assert "pairing_code_hash = NULL" in register
    assert "datetime.now(" not in register
    assert "const now = new Date()" not in register

def test_dynamic_sql_identifiers_are_composed_with_psycopg2_identifier():
    offenders = []
    for path in (ROOT / "odoo_addons19").rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        for line_no, line in enumerate(source.splitlines(), 1):
            if "_table" in line and "%" in line and "sql.Identifier" not in line:
                offenders.append(f"{path.relative_to(ROOT)}:{line_no}:{line.strip()}")
            if "{self._table}" in line and line.lstrip().startswith("f") and "sql.Identifier" not in line:
                offenders.append(f"{path.relative_to(ROOT)}:{line_no}:{line.strip()}")
            if " % table" in line and "sql.Identifier" not in line:
                offenders.append(f"{path.relative_to(ROOT)}:{line_no}:{line.strip()}")
    assert not offenders, "raw SQL identifier formatting remains:\n" + "\n".join(offenders)


def test_odoo_js_device_class_filter_uses_only_canonical_gateway_values():
    """
    Cross-boundary consistency regression: the Odoo JS runtime_printer_field.js uses
    deviceClass values to filter printer suggestions. Those values must be a subset of
    the canonical DEVICE_CLASSES from src/lib/printer-model.ts. The Gateway schema
    rejects any other value, so phantom values like 'barcode' are dead-code filters
    that silently drift from the contract.
    """
    import re
    ts_source = (ROOT / "src" / "lib" / "printer-model.ts").read_text(encoding="utf-8")
    m = re.search(r'DEVICE_CLASSES\s*=\s*\[([^\]]+)\]', ts_source)
    assert m, "DEVICE_CLASSES not found in src/lib/printer-model.ts"
    canonical = {v.strip().strip('"') for v in m.group(1).split(",")}
    assert canonical == {"thermal", "laser", "inkjet", "label", "other", "unknown"}

    js_source = (ROOT / "odoo_addons19" / "print_gateway" / "static" / "src" / "components" / "runtime_printer_field.js").read_text(encoding="utf-8")
    filter_arrays = re.findall(r'\[([^\]]+)\]\.includes\(\(p\.deviceClass', js_source)
    for arr_src in filter_arrays:
        used = {v.strip().strip('"\'') for v in arr_src.split(",")}
        non_canonical = used - canonical
        assert not non_canonical, (
            f"runtime_printer_field.js deviceClass filter uses non-canonical values: {non_canonical}. "
            f"The API rejects these; remove them so the filter stays in sync with DEVICE_CLASSES."
        )


def test_payload_ceiling_is_5mib_decoded_everywhere():
    source = read("models/print_job.py")
    assert "8 * 1024 * 1024" not in source
    assert "MAX_PRINT_CONTENT_BYTES = 5 * 1024 * 1024" in source


def test_pos_operation_identity_chain_receipt_and_sale_details():
    router = (ADDON / "models/print_router.py").read_text(encoding="utf-8")
    order = (ADDON / "models/pos_order.py").read_text(encoding="utf-8")
    session = (ADDON / "models/pos_session.py").read_text(encoding="utf-8")
    receipt_js = (ADDON / "static/src/js/pos_print_router.js").read_text(encoding="utf-8")
    details_js = (ADDON / "static/src/js/pos_sale_details_router.js").read_text(encoding="utf-8")
    # Server accepts caller operation identity on every POS path.
    assert "def route_pos_receipt(self, order, image_base64, *, idempotency_key=None, geometry_fingerprint=None)" in router
    assert "def route_pos_sale_details(self, session, image_base64, *, idempotency_key=None, geometry_fingerprint=None)" in router
    assert "def action_print_gateway_receipt(self, image, operation_id=None, geometry_fingerprint=None)" in order
    assert "idempotency_key=operation_id" in order
    assert "def action_print_gateway_sale_details(self, image, operation_id=None, geometry_fingerprint=None)" in session
    assert "idempotency_key=operation_id" in session
    # Clients mint one id per click, coalesce in-flight duplicates, and keep
    # uncertain operations retryable with the same id.
    assert "operation_id: operationId" in receipt_js
    assert "gatewayUuid()" in receipt_js
    assert "gatewayReceiptPending" in receipt_js
    assert "gatewayReceiptOperations" in receipt_js
    assert "operation_id: operationId" in details_js
    assert "gatewaySaleDetailsPending" in details_js
    assert "gatewaySaleDetailsOperations" in details_js


def test_report_operation_identity_chain():
    router = (ADDON / "models/print_router.py").read_text(encoding="utf-8")
    binding = (ADDON / "models/binding.py").read_text(encoding="utf-8")
    interceptor = (ADDON / "static/src/js/report_interceptor.js").read_text(encoding="utf-8")
    assert "def route_report(self, report, records, data=None, explicit_binding=None, idempotency_key=None)" in router
    assert "def dispatch_report_action(self, report_name=None, report_id=None, res_ids=None, context=None, data=None, operation_id=None)" in binding
    assert "idempotency_key=operation_id" in binding
    assert "function reportOperationUuid()" in interceptor
    assert "claimPrintOperation(recoveryKey," in interceptor
    assert "operation_id: claim.id" in interceptor
    assert "finishPrintOperation(recoveryKey, operation.request.operation_id)" in interceptor
    assert "const reportOperations = new WeakMap();" in interceptor


def test_raw_wire_types_match_gateway_contract():
    router = (ADDON / "models/print_router.py").read_text(encoding="utf-8")
    # The Gateway contract (contracts/print-payload-contract.json wireTypes)
    # admits only raw/escpos/pdf/image as wire types; zpl/tspl travel as
    # type=raw with an explicit protocol. Emitting type=zpl/tspl fails
    # Gateway validation, so the router must never do it.
    assert 'wire_type = "escpos" if protocol == "escpos" else "raw"' in router
    assert '"type": "zpl"' not in router
    assert '"type": "tspl"' not in router
    assert "'type': 'zpl'" not in router
    assert "'type': 'tspl'" not in router


def test_picking_destination_without_report_computes_label_document_type():
    binding = (ADDON / "models/binding.py").read_text(encoding="utf-8")
    compute = binding[binding.index("def _compute_document_type"):]
    compute = compute[:compute.index("def _compute_name")]
    # The raw-label automation path (route_raw_command document_type="label",
    # raw_template policy intents) must have a matchable binding mode.
    assert 'elif record.destination_type == "picking_type":' in compute
    assert 'record.document_type = "label"' in compute
    # Report routing is preserved: report-bound bindings keep report:* types.
    assert 'elif record.report_id or record.destination_report_id:' in compute
    assert compute.index('elif record.report_id') < compute.index('elif record.destination_type == "picking_type":')
    # POS routing is preserved.
    assert 'record.document_type = "receipt"' in compute
    assert 'record.document_type = "kitchen"' in compute


def test_branch_destinations_not_blocked_by_automatic_company_check():
    # F021: binding.company_id is always ROOT while a branch binding needs a
    # branch-owned destination. check_company=True on the destination fields
    # made the two checks jointly unsatisfiable; _check_binding (effective
    # company) is the authority instead.
    binding = (ADDON / "models/binding.py").read_text(encoding="utf-8")
    for field in ("destination_pos_config_id", "destination_pos_printer_id", "destination_picking_type_id"):
        block = binding[binding.index(field):binding.index(field) + 600]
        assert "check_company" not in block, field
    assert "destination_company and destination_company != expected_company" in binding


def test_document_type_computation_survives_empty_report_name():
    # F023: (report_name or id).strip() crashes on int id when report_name
    # is falsy; the fallback must be coerced to str first.
    binding = (ADDON / "models/binding.py").read_text(encoding="utf-8")
    compute = binding[binding.index("def _compute_document_type"):]
    compute = compute[:compute.index("def _compute_name")]
    assert "(report.report_name or report.id).strip()" not in compute
    assert "str(report.id)" in compute


def test_printer_widget_normalizes_legacy_spooler_alias():
    # F024: legacy windows_spooler transports must resolve like the server
    # canonicalization, not to "unknown".
    widget = (ADDON / "static/src/components/runtime_printer_field.js").read_text(encoding="utf-8")
    assert 'connectionType === "windows_spooler"' in widget
    assert 'protocol === "windows_spooler"' in widget


def test_print_activity_record_rules_reach_branch_rows_from_the_root_operator():
    # ODO-05/ODO-07: a print job and a print intent are owned by the company
    # of the record that produced them. For a Branch-owned print that is the
    # Branch company, so a root-Company operator must still see it, otherwise
    # the documented recovery path ("check Print Activity before retrying")
    # silently shows an empty list for exactly the failed Branch print that
    # needs reconciliation, and a permanently failed Branch intent cannot be
    # re-armed from Automation Activity.
    #
    # The second clause is restricted to direct children of an activated
    # company, so it never reaches into another Company's branches.
    security = read("security/security.xml")
    assert "('company_id', 'in', company_ids), ('company_id.parent_id', 'in', company_ids)" in security
    job_rule = security[security.index('id="rule_print_job_company"'):]
    job_rule = job_rule[:job_rule.index("</record>")]
    assert "('company_id.parent_id', 'in', company_ids)" in job_rule
    intent_rule = security[security.index('id="rule_print_intent_company"'):]
    intent_rule = intent_rule[:intent_rule.index("</record>")]
    assert "('company_id.parent_id', 'in', company_ids)" in intent_rule
    # The company-wide rules must keep their existing scope.
    config_rule = security[security.index('id="rule_gateway_config_company"'):]
    config_rule = config_rule[:config_rule.index("</record>")]
    assert "company_id.child_ids" in config_rule


def test_pos_receipt_degrades_gracefully_to_native_when_the_enablement_probe_fails():
    # POS fault tolerance: a failed pre-dispatch enablement probe never blocks
    # POS receipt printing; it logs a warning and degrades to native printing.
    source = read("static/src/js/pos_print_router.js")
    receipt_start = source.index("async printReceipt")
    receipt_end = source.index("getOrderData", receipt_start)
    receipt = source[receipt_start:receipt_end]

    probe_index = receipt.index("is_gateway_printing_enabled")
    probe_block = receipt[probe_index - 400: probe_index + 900]
    assert "catch (probeError)" in probe_block
    assert "return super.printReceipt" in probe_block
    assert receipt.index("if (gatewayEnabled !== true)") > receipt.index("catch (probeError)")


def test_odoo_failure_paths_surface_the_durable_operation_reference():
    # ODO-01/ODO-02: the operator was told to "check Print Activity" but the
    # toast never carried the operation reference, so the row could not be
    # found. The durable reference must be surfaced on the fail-closed paths.
    interceptor = read("static/src/js/report_interceptor.js")
    assert "Operation reference: %s" in interceptor
    assert "operation?.request?.operation_id" in interceptor

    pos = read("static/src/js/pos_print_router.js")
    assert "operation reference" in pos
    assert "activePrintClaim?.id" in pos


def test_dispatch_exception_keeps_the_original_detail_server_side():
    # ODO-03: the client-facing message stays generic (it must not leak
    # internals), but the server log must keep the original exception and
    # its traceback for diagnosis.
    binding = read("models/binding.py")
    assert 'exc_info=True' in binding
    assert "Failed to execute silent print route" in binding


def test_intent_attempt_ceiling_fences_pending_at_claim_and_cron_selection():
    # An exhausted pending intent must not acquire another print attempt.
    source = read("models/print_intent.py")
    claim = source[source.index("def _claim_intent"):source.index("def _finalize_intent_state")]
    assert "(status = 'pending' AND attempts < max_attempts" in claim
    cron = source[source.index("def cron_recover_pending_intents"):]
    assert "(status = 'pending' AND attempts < max_attempts" in cron


def test_stale_agent_sweep_never_requeues_after_physical_dispatch_started():
    source = read("models/agent.py")
    sweep = source.split("def _cron_sweep_stale_agents(", 1)[1].split("return True", 1)[0]
    # `claimed` is still pre-dispatch: Go must obtain the `printing` ACK
    # before sending any physical bytes. Once `printing` was acknowledged,
    # an expired lease has an ambiguous physical outcome and is terminal.
    assert "SET status = 'queued'" in sweep
    assert "WHERE status = 'claimed'" in sweep
    assert "SET status = 'unknown'" in sweep
    assert "WHERE status = 'printing'" in sweep
    assert "UNKNOWN_PARTIAL_DELIVERY:" in sweep
    assert "status IN ('claimed', 'printing')" not in sweep


def test_pos_invoice_and_picking_report_dispatch_invariants():
    manifest = ast.literal_eval((ADDON / "__manifest__.py").read_text(encoding="utf-8"))
    pos_assets = manifest["assets"]["point_of_sale._assets_pos"]
    assert "print_gateway/static/src/js/report_interceptor.js" in pos_assets

    account_move = read("models/account_move.py")
    assert "def action_invoice_download_pdf" in account_move
    assert "def action_print_pdf" in account_move
    assert "print_gateway_client_dispatch=True" in account_move

    stock_picking = read("models/stock_picking.py")
    assert "def do_print_picking" in stock_picking
    assert "def _get_autoprint_report_actions" in stock_picking
    assert "print_gateway_client_dispatch=True" in stock_picking

    report = read("models/ir_actions_report.py")
    assert 'self.env.context.get("print_gateway_client_dispatch")' in report

    recovery = read("static/src/js/operation_recovery.js")
    assert "export async function pollQueuedPrintJob" in recovery
    for js_name in ("report_interceptor.js", "pos_print_router.js", "pos_sale_details_router.js"):
        assert "pollQueuedPrintJob(" in read(f"static/src/js/{js_name}")
