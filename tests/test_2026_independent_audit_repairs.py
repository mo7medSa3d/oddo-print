"""Portable executable regressions for the October 8 independent audit.

Does not need an Odoo database: tests pure rendering and repository boundaries.
The in-database Odoo control-plane scenarios live in test_control_plane.py.
"""
from __future__ import annotations

import ast
import string
import types
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


class ValidationError(Exception):
    pass


def policy_renderer(template):
    """Compile the real Odoo render method against inert doubles, no ORM import."""
    source = read("odoo_addons/print_gateway/models/print_policy.py")
    tree = ast.parse(source)
    klass = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "PrintGatewayPolicy")
    methods = [n for n in klass.body if isinstance(n, ast.FunctionDef) and n.name in ("render_raw_template", "_sanitize_template_field")]
    for node in methods:
        node.decorator_list = []
    sanitizer = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "sanitize_raw_value")
    code = compile(ast.Module(body=[sanitizer] + methods, type_ignores=[]), "print_policy.py", "exec")
    scope = {"ValidationError": ValidationError, "string": string, "_": lambda message: message}
    exec(code, scope)
    class Policy:
        name = "Test Raw Label"
        raw_protocol = "zpl"
        raw_template = template
        MAX_RAW_TEMPLATE_BYTES = 64 * 1024
        MAX_RENDERED_LABEL_BYTES = 512 * 1024
        def ensure_one(self):
            return self
    policy = Policy()
    policy._sanitize_template_field = types.MethodType(scope["_sanitize_template_field"], policy)
    policy.render_raw_template = types.MethodType(scope["render_raw_template"], policy)
    return policy


def test_F01_reportless_picking_has_label_document_type_and_routable_form():
    binding = read("odoo_addons/print_gateway/models/binding.py")
    view = read("odoo_addons/print_gateway/views/binding_views.xml")
    assert 'record.document_type = "label"' in binding
    assert 'elif record.destination_type == "picking_type":' in binding
    assert 'record.printer_protocol not in ("zpl", "tspl", "escpos", "raw")' in binding
    assert 'required="destination_type == \'report\'"' in view
    assert 'required="destination_type not in' not in view


def test_F01_implicit_protocol_is_filtered_before_priority_even_for_root_fallback():
    binding = read("odoo_addons/print_gateway/models/binding.py")
    resolve = binding[binding.index("def find_for"):binding.index("def dispatch_report_action")]
    assert '("printer_protocol", "=", str(protocol).strip().lower())' in resolve
    assert resolve.count("+ protocol_domain") == 2
    assert "protocol=protocol," in read("odoo_addons/print_gateway/models/print_router.py")


def test_F02_preflight_failure_persists_a_real_failed_intent_for_cron_recovery():
    policy = read("odoo_addons/print_gateway/models/print_policy.py")
    intent = read("odoo_addons/print_gateway/models/print_intent.py")
    assert "record_preflight_failure(" in policy
    assert "self.env.cr.savepoint()" in policy
    assert '"status": "failed"' in intent
    assert '"next_retry_at": db_now_utc(self.env.cr)' in intent
    assert "(status = 'failed' AND attempts < max_attempts" in intent


def test_F03_sync_uses_oldest_attempt_and_skip_locked_not_oldest_id():
    job = read("odoo_addons/print_gateway/models/print_job.py")
    area = job[job.index("def cron_sync_status"):]
    assert "status_sync_attempted_at" in area
    assert "NULLS FIRST" in area
    assert "FOR UPDATE SKIP LOCKED" in area
    assert "LIMIT 100" in area


def test_F04_business_event_identity_changes_only_across_a_new_transition():
    source = read("odoo_addons/print_gateway/models/print_intent.py")
    assert 'raw += ":transition:" + str(event_identity)' in source
    for hook in ("account_move.py", "stock_picking.py"):
        assert "print_gateway_event_identity=" in read("odoo_addons/print_gateway/models/" + hook)


def test_F05_successful_transport_is_not_physical_paper_proof():
    status = read("src/lib/job-status.ts")
    route = read("src/app/api/jobs/route.ts")
    assert 'if (status === "success") return "unknown"' in status
    assert 'if (statusParam === "printed")' in route
    assert 'Physical paper output is not independently verified' in route
    assert 'conditions.push(eq(printJobs.status, "success"))' in route


def test_F06_pos_image_peripherals_cannot_be_misconfigured_as_active_escpos():
    binding = read("odoo_addons/print_gateway/models/binding.py")
    assert "def _check_peripheral_transport_support(self):" in binding
    assert 'record.destination_type in ("pos", "pos_printer")' in binding
    assert "record.get_peripheral_payload()" in binding


def test_F07_pdf_ipp_requires_actual_advertised_format_before_print_job():
    ipp = read("agent/internal/printer/ipp.go")
    odoo = read("src/app/api/odoo/printers/route.ts")
    assert '"document-format-supported"' in ipp
    assert "func (p *IPPPrinter) requireDocumentFormat" in ipp
    assert "if err := p.requireDocumentFormat(ctx, documentFormat); err != nil" in ipp
    assert "ippFormatListed(formats, mime)" in ipp
    assert "document_formats" in odoo
    assert "else supported.delete(\"pdf\")" in odoo


def test_F08_unknown_ipp_has_bounded_specific_diagnostic_reason():
    ipp = read("agent/internal/printer/ipp.go")
    assert "ippProbeReason(err)" in ipp
    for diagnostic in ("authentication_required", "access_denied", "dns_failure", "network_unavailable", "invalid_ipp_response", "timeout"):
        assert diagnostic in ipp


def test_F09_raw_template_fetches_only_placeholders_never_unrelated_fields():
    class Record:
        _fields = {"name": types.SimpleNamespace(type="char"), "expensive": types.SimpleNamespace(type="char")}
        name = "Safe"
        @property
        def expensive(self):
            raise AssertionError("Unrelated expensive ORM field was accessed")
    assert policy_renderer("^XA^FD{name}^FS^XZ").render_raw_template(Record()) == "^XA^FDSafe^FS^XZ"


@pytest.mark.parametrize("template", ["{name:>100000000}", "{name!r}", "{name.__class__}", "{name:{name}}"])
def test_F10_unbounded_or_unsafe_raw_formats_are_rejected(template):
    class Record:
        _fields = {"name": types.SimpleNamespace(type="char")}
        name = "Safe"
    with pytest.raises(ValidationError, match="forbidden"):
        policy_renderer(template).render_raw_template(Record())


def test_F10_raw_template_size_is_bounded_even_without_placeholders():
    with pytest.raises(ValidationError, match="64 KiB"):
        policy_renderer("X" * (64 * 1024 + 1)).render_raw_template(object())


def test_F11_discovery_is_paginated_and_single_device_lookup_is_targeted():
    for p in ("src/app/api/odoo/agents/route.ts", "src/app/api/odoo/printers/route.ts"):
        src = read(p)
        assert ".limit(limit + 1)" in src and ".offset(offset)" in src
        assert "nextOffset" in src and "hasMore" in src
        assert "apiKey.tenantId" in src
    binding = read("odoo_addons/print_gateway/models/binding.py")
    assert 'params={"agent_id": self.runtime_agent_id}' in binding
    assert '"printer_id": self.printer_id' in binding
    controller = read("odoo_addons/print_gateway/controllers/runtime_printers.py")
    assert "def _fetch_runtime_inventory" in controller
    assert "body.get('hasMore')" in controller


def test_F12_ipp_supports_an_explicit_local_test_page_not_an_unsupported_error():
    ipp = read("agent/internal/printer/ipp.go")
    implementation = ipp[ipp.index("func (p *IPPPrinter) Test("):ipp.index("// Status differentiates")]
    assert "return p.PrintDocument(ctx, Document{Kind: KindPDF" in implementation
    assert "%%EOF" in implementation
    assert "not supported" not in implementation


def test_F13_incremental_helper_extraction_keeps_inventory_validation_separate():
    controller = read("odoo_addons/print_gateway/controllers/runtime_printers.py")
    assert "def _fetch_runtime_inventory" in controller
    assert "def runtime_agents(" in controller and "def runtime_printers(" in controller


def test_F14_second_pos_ticket_requires_explicit_opt_in_and_ui_warning():
    policy = read("odoo_addons/print_gateway/models/print_policy.py")
    view = read("odoo_addons/print_gateway/views/print_policy_views.xml")
    assert "allow_additional_pos_output" in policy
    assert "may produce a second physical ticket" in policy
    assert 'selected.destination_type in ("pos", "pos_printer")' in policy
    assert "allow_additional_pos_output" in view


def test_odoo_views_remain_well_formed_xml():
    for path in ("odoo_addons/print_gateway/views/binding_views.xml", "odoo_addons/print_gateway/views/print_policy_views.xml"):
        ET.fromstring(read(path))
