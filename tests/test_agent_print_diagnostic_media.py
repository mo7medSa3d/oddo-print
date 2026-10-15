"""Exercise production diagnostic rendering with isolated external ORM/HTTP records.

These tests prove media selection and context isolation, not wkhtmltopdf shaping
or a Windows driver's supported forms and physical paper output.
"""
import ast
import base64
import re
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

from test_f010_report_binding_identity import ValidationError, production_methods


ROOT = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway"
RouterProduction = production_methods("print_router.py", [
    "_generate_test_pdf", "_route_spooler_test_page", "_route_ipp_test_page",
    "_diagnostic_paper_width_for_binding",
])
RouterProduction._generate_test_pdf.__globals__.update(base64=base64, textwrap=textwrap)
ReportProduction = production_methods("ir_actions_report.py", ["get_paperformat"])


def dimensions(pdf):
    match = re.search(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]", pdf)
    assert match, "diagnostic must declare its actual physical page"
    return tuple(float(value) for value in match.groups())


@pytest.mark.parametrize("width", [None, 58, 80])
def test_ascii_diagnostic_declares_media_and_valid_offsets(width):
    pdf = RouterProduction()._generate_test_pdf(
        company_name="Wide " + "W" * 100, branch_name=r"Branch (one)\two",
        printer_name="POS80", now_str="2026-10-14 12:34:56", paper_width_mm=width,
    )
    expected = (width * 72 / 25.4, 100 * 72 / 25.4) if width else (612, 792)
    assert dimensions(pdf) == pytest.approx(expected)
    stream = re.search(rb"/Length (\d+) >>\nstream\n(.*?)\nendstream", pdf, re.S)
    assert stream and int(stream[1]) == len(stream[2])
    xref_position = int(re.search(rb"startxref\n(\d+)", pdf)[1])
    assert pdf[xref_position:xref_position + 4] == b"xref"
    offsets = re.findall(rb"(\d{10}) 00000 n \n", pdf[xref_position:])
    assert len(offsets) == 5
    for number, offset in enumerate(offsets, 1):
        assert pdf[int(offset):].startswith(f"{number} 0 obj\n".encode())
    assert b"\\(one\\)\\\\two" in pdf
    if width:
        assert b"/F1 8 Tf" in stream[2]
        # Actual emitted line count stays within the 100mm ticket, even with
        # maximum-length wide names; no glyph transfer or replay is involved.
        emitted_lines = len(re.findall(rb"\) Tj", stream[2]))
        assert expected[1] - 14 - (emitted_lines - 1) * 12 > 10
    else:
        assert b"/F1 24 Tf" in stream[2]


@pytest.mark.parametrize("width", [True, False, "58", 57, 81, [], float("nan")])
def test_invalid_explicit_diagnostic_media_fails_before_render(width):
    with pytest.raises(ValidationError, match="58 or 80"):
        RouterProduction()._generate_test_pdf(
            company_name="Company", branch_name="Branch", printer_name="Printer",
            now_str="2026-10-14", paper_width_mm=width,
        )


def test_office_diagnostic_wraps_wide_metadata_inside_its_pdf_page():
    name = "W" * 80
    pdf = RouterProduction()._generate_test_pdf(
        company_name=name, branch_name=name, printer_name=name,
        now_str="2026-10-15 12:00:00",
    )
    assert dimensions(pdf) == (612, 792)
    stream = re.search(rb"stream\n(.*?)\nendstream", pdf, re.S)[1]
    body = stream.split(b"/F1 12 Tf\n0 -30 Td\n", 1)[1]
    lines = re.findall(rb"\(([^()]*)\) Tj", body)
    assert lines and all(len(line) <= 39 for line in lines)
    assert sum(line.count(b"W") for line in lines) == 240
    assert 650 - (len(lines) - 1) * 20 > 72


@pytest.mark.parametrize("method_name", ["_route_spooler_test_page", "_route_ipp_test_page"])
@pytest.mark.parametrize("width", [None, False, 58, 80, 210])
def test_transport_uses_exact_binding_media_and_identity(method_name, width):
    capabilities = {} if width is None else {"paper_width_mm": width}
    validated = []
    selected = SimpleNamespace(id=71, document_type="receipt")
    selected._validate_runtime_target = lambda: validated.append(selected.id) or {"capabilities": capabilities}
    company = SimpleNamespace(id=4)

    class Router(RouterProduction):
        def resolve_binding(self, **kwargs):
            assert kwargs == dict(record=False, company=company, document_type="receipt",
                                  explicit_binding=selected, payload_type="pdf")
            return {"binding": selected, "printer_id": "exact-printer", "native": False}

        def _submit_route(self, **kwargs):
            self.submission = kwargs
            return {"status": "submitted"}

    router = Router()
    result = getattr(router, method_name)(
        binding=selected, company=company, company_name="Company",
        branch_name="Branch", printer_name="POS80", now_str="2026-10-14",
    )
    assert result == {"status": "submitted"}
    assert validated == [71]
    assert router.submission["source_model"] == "print_gateway.binding"
    assert router.submission["source_record_id"] == selected.id
    assert router.submission["route"]["binding"] is selected
    payload = router.submission["payload"]
    assert payload["type"] == "pdf" and payload["encoding"] == "base64"
    expected = (width * 72 / 25.4, 100 * 72 / 25.4) if type(width) is int and width in (58, 80) else (612, 792)
    # A POS80 name without declared roll width must retain the office default.
    assert dimensions(base64.b64decode(payload["data"])) == pytest.approx(expected)


@pytest.mark.parametrize("method_name", ["_route_spooler_test_page", "_route_ipp_test_page"])
def test_native_route_rejected_before_media_lookup_or_render(method_name):
    def unexpected(*args, **kwargs):
        raise AssertionError("native diagnostics must not fetch metadata, render or submit")

    selected = SimpleNamespace(id=71, document_type="receipt", _validate_runtime_target=unexpected)

    class Router(RouterProduction):
        resolve_binding = lambda self, **kwargs: {"native": True}
        _generate_test_pdf = unexpected
        _submit_route = unexpected

    with pytest.raises(ValidationError, match="native print"):
        getattr(Router(), method_name)(binding=selected, company="company", company_name="Company",
                                     branch_name="Branch", printer_name="Printer", now_str="2026-10-14")


@pytest.mark.parametrize("destination_type", ["pos", "pos_printer"])
@pytest.mark.parametrize("width", [None, False, "80", 58.0, 72.1, 210])
def test_direct_ipp_thermal_receipt_requires_verified_roll_before_render_or_outbox(destination_type, width):
    selected = SimpleNamespace(id=71, destination_type=destination_type, document_type="receipt")
    selected._validate_runtime_target = lambda: {
        "deviceClass": "thermal", "capabilities": {} if width is None else {"paper_width_mm": width},
    }
    calls = []

    class Router(RouterProduction):
        def resolve_binding(self, **kwargs):
            assert kwargs["explicit_binding"] is selected
            calls.append("validated-exact-binding")
            return {"native": False}

        def _generate_test_pdf(self, **kwargs):
            raise AssertionError("unproved receipt media must not reach either PDF renderer")

        def _submit_route(self, **kwargs):
            raise AssertionError("unproved receipt media must not create or submit an outbox job")

    with pytest.raises(ValidationError, match="58 or 80 mm.*sync"):
        Router()._route_ipp_test_page(binding=selected, company="company", company_name="شركة",
                                    branch_name="فرع", printer_name="POS80", now_str="2026-10-14")
    assert calls == ["validated-exact-binding"]


@pytest.mark.parametrize("destination_type", ["pos", "pos_printer"])
@pytest.mark.parametrize("width", [None, False, "80", 58.0, 72.1, 210])
def test_spooler_thermal_diagnostic_defers_unproved_media_to_selected_driver(destination_type, width):
    selected = SimpleNamespace(id=71, destination_type=destination_type, document_type="receipt")
    calls = []

    def validate():
        calls.append("validated-runtime")
        return {"deviceClass": "thermal", "capabilities": {} if width is None else {"paper_width_mm": width}}

    selected._validate_runtime_target = validate

    class Router(RouterProduction):
        def resolve_binding(self, **kwargs):
            assert kwargs == dict(record=False, company="company", document_type="receipt",
                                  explicit_binding=selected, payload_type="pdf")
            calls.append("validated-exact-binding")
            return {"native": False, "binding": selected}

        def _submit_route(self, **kwargs):
            assert kwargs["route"]["binding"] is selected
            assert kwargs["source_model"] == "print_gateway.binding"
            assert kwargs["source_record_id"] == selected.id
            payload = kwargs["payload"]
            assert set(payload) == {"type", "encoding", "data"}
            assert payload["type"] == "pdf" and payload["encoding"] == "base64"
            # No roll is guessed; the Agent must fit the complete PDF to its real driver DC.
            assert dimensions(base64.b64decode(payload["data"])) == (612, 792)
            calls.append("submitted-exact-binding")
            return {"status": "submitted"}

    assert Router()._route_spooler_test_page(
        binding=selected, company="company", company_name="Company",
        branch_name="Branch", printer_name="POS80", now_str="2026-10-14",
    ) == {"status": "submitted"}
    assert calls == ["validated-exact-binding", "validated-runtime", "submitted-exact-binding"]


@pytest.mark.parametrize("method_name", ["_route_spooler_test_page", "_route_ipp_test_page"])
@pytest.mark.parametrize("destination_type,device_class,width", [
    ("report", "thermal", None), ("report", "laser", None),
    ("report", "inkjet", 210), ("pos", "laser", None),
    ("pos_printer", "inkjet", None), ("pos", "unknown", None),
])
def test_report_and_office_diagnostics_keep_existing_media_without_name_inference(method_name, destination_type, device_class, width):
    selected = SimpleNamespace(id=71, destination_type=destination_type, document_type="receipt")
    selected._validate_runtime_target = lambda: {
        "deviceClass": device_class, "capabilities": {"paper_width_mm": width},
    }

    class Router(RouterProduction):
        def resolve_binding(self, **kwargs):
            assert kwargs["explicit_binding"] is selected
            return {"native": False, "binding": selected}

        def _submit_route(self, **kwargs):
            assert kwargs["route"]["binding"] is selected
            return kwargs["payload"]

    payload = getattr(Router(), method_name)(binding=selected, company="company", company_name="Company",
                                           branch_name="Branch", printer_name="POS80", now_str="2026-10-14")
    assert dimensions(base64.b64decode(payload["data"])) == (612, 792)


@pytest.mark.parametrize("method_name", ["_route_spooler_test_page", "_route_ipp_test_page"])
@pytest.mark.parametrize("destination_type", ["pos", "pos_printer"])
@pytest.mark.parametrize("width", [58, 80])
def test_known_thermal_receipt_keeps_exact_media_for_unicode_renderer(method_name, destination_type, width):
    selected = SimpleNamespace(id=71, destination_type=destination_type, document_type="receipt")
    selected._validate_runtime_target = lambda: {
        "deviceClass": "thermal", "capabilities": {"paper_width_mm": width},
    }
    calls = []

    class Report:
        def with_context(self, **context):
            assert context == {"force_report_rendering": True, "print_gateway_diagnostic_paper_width_mm": width}
            return self

        def _render_qweb_pdf(self, report_ref, **kwargs):
            assert report_ref == "print_gateway.action_diagnostic_report"
            assert kwargs["data"]["paper_width_mm"] == width
            calls.append("rendered-unicode")
            return b"%PDF-1.4\nexternal shaped diagnostic", "pdf"

    class Router(RouterProduction):
        env = {"ir.actions.report": Report()}

        def resolve_binding(self, **kwargs):
            assert kwargs["explicit_binding"] is selected
            return {"native": False, "binding": selected}

        def _submit_route(self, **kwargs):
            assert kwargs["route"]["binding"] is selected
            assert kwargs["source_record_id"] == selected.id
            assert base64.b64decode(kwargs["payload"]["data"]) == b"%PDF-1.4\nexternal shaped diagnostic"
            calls.append("submitted-exact-binding")
            return {"status": "submitted"}

    result = getattr(Router(), method_name)(binding=selected, company="company", company_name="شركة",
                                          branch_name="فرع", printer_name="طابعة", now_str="2026-10-14")
    assert result == {"status": "submitted"}
    assert calls == ["rendered-unicode", "submitted-exact-binding"]


@pytest.mark.parametrize("width", [None, 58, 80])
def test_unicode_uses_shaping_report_with_local_bounded_media(width):
    calls = []

    class Report:
        def with_context(self, **context):
            self.context = context
            return self

        def _render_qweb_pdf(self, report_ref, **kwargs):
            calls.append((self.context, report_ref, kwargs))
            return b"%PDF-1.4\nshaped by external renderer", "pdf"

    router = RouterProduction()
    router.env = {"ir.actions.report": Report()}
    name = "شركة" * 30
    pdf = router._generate_test_pdf(
        company_name=name, branch_name="فرع", printer_name="طابعة",
        now_str="2026-10-14", paper_width_mm=width,
    )
    assert pdf.startswith(b"%PDF-")
    context, ref, kwargs = calls[0]
    assert ref == "print_gateway.action_diagnostic_report"
    assert context == {"force_report_rendering": True, "print_gateway_diagnostic_paper_width_mm": width}
    assert kwargs["res_ids"] == [] and kwargs["data"]["paper_width_mm"] == width
    assert kwargs["data"]["company_name"] == (name[:40] if width else name)


class DefaultReport:
    def get_paperformat(self):
        return "existing-office-format"


class Report(ReportProduction, DefaultReport):
    def __init__(self, name, width):
        self.report_name = name
        self.new_formats = []
        formats = SimpleNamespace(new=lambda values: self.new_formats.append(values) or SimpleNamespace(**values))

        class Env:
            context = {"print_gateway_diagnostic_paper_width_mm": width}

            def __getitem__(self, model):
                assert model == "report.paperformat"
                return formats

        self.env = Env()


def test_paperformat_override_is_diagnostic_only_and_concurrently_isolated():
    narrow = Report("print_gateway.diagnostic_report", 58)
    wide = Report("print_gateway.diagnostic_report", 80)
    narrow_format, wide_format = narrow.get_paperformat(), wide.get_paperformat()
    assert narrow_format.page_width == 58 and wide_format.page_width == 80
    assert narrow_format.page_height == wide_format.page_height == 100
    assert narrow_format.format == "custom" and narrow_format.margin_top == 4
    assert narrow.new_formats != wide.new_formats
    assert narrow.get_paperformat().page_width == 58
    for name, width in [("sale.report_saleorder", 58), ("print_gateway.diagnostic_report", None),
                        ("print_gateway.diagnostic_report", True), ("print_gateway.diagnostic_report", "80")]:
        report = Report(name, width)
        assert report.get_paperformat() == "existing-office-format"
        assert not report.new_formats


def runtime_controller(printer):
    tree = ast.parse((ROOT / "controllers/runtime_printers.py").read_text())
    method = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "runtime_printers")
    method.decorator_list = []
    responses = iter([
        {"agents": [{"id": "agent-a", "lifecycle": "active"}]}, {"printers": [printer]},
    ])

    def get(url, **kwargs):
        assert kwargs["allow_redirects"] is False and kwargs["timeout"] == 5
        body = next(responses)
        return SimpleNamespace(status_code=200, content=b"json", json=lambda: body)

    namespace = {"ValidationError": ValidationError, "Forbidden": PermissionError,
                 "request": SimpleNamespace(env=SimpleNamespace(_=lambda value: value)),
                 "requests": SimpleNamespace(get=get, RequestException=OSError)}
    policy_path = ROOT / "runtime_policy.py"
    policy_namespace = {}
    exec(compile(policy_path.read_text(), str(policy_path), "exec"), policy_namespace)
    namespace["is_gateway_shared_printer"] = policy_namespace["is_gateway_shared_printer"]
    exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])),
                 str(ROOT / "controllers/runtime_printers.py"), "exec"), namespace)
    config = SimpleNamespace(_gateway_base=lambda **kwargs: "https://gateway.invalid",
                             _gateway_headers=lambda: {"X-API-Key": "fixture"})
    controller = SimpleNamespace(_require_runtime_admin=lambda: None,
                                 _scope=lambda company, branch: ("company", "branch"),
                                 _get_config=lambda company: (config, "root"),
                                 _assigned_runtime_agent_ids=lambda root, branch: {"agent-a"})
    return namespace["runtime_printers"](controller, company_id=1, branch_id=2, agent_id="agent-a")


@pytest.mark.parametrize("width", [58, 80, True, "58", 58.0, None, 79])
def test_picker_preserves_only_declared_integer_receipt_width(width):
    printer = {"id": "printer-a", "name": "POS80", "lifecycle": "active", "agent": {"id": "agent-a"},
               "capabilities": {"supported_protocols": [" PDF ", "pdf", "spooler", "bad"],
                                "paper_width_mm": width, "private": "do not expose"}}
    result = runtime_controller(printer)
    assert result["selectedAgentId"] == "agent-a"
    capabilities = result["printers"][0]["capabilities"]
    expected = {"supported_protocols": ["pdf", "spooler"]}
    if type(width) is int and width in (58, 80):
        expected["paper_width_mm"] = width
    assert capabilities == expected


@pytest.mark.parametrize("protocol,ticket", [
    ("tspl", "SELFTEST\r\n"),
    ("zpl", "^XA\n^FO4,4^A0N,12,12^FDTEST^FS\n^XZ\n"),
])
def test_label_diagnostic_preserves_media_and_cannot_embed_metadata_commands(protocol, ticket):
    production = production_methods("print_router.py", ["route_test_page"])
    namespace = production.route_test_page.__globals__
    tree = ast.parse((ROOT / "models/print_router.py").read_text())
    sanitizers = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                  and node.name in ("_zpl_text", "_tspl_text", "_escpos_text")]
    assert len(sanitizers) == 3
    exec(compile(ast.Module(body=sanitizers, type_ignores=[]), str(ROOT / "models/print_router.py"), "exec"), namespace)
    namespace["fields"] = SimpleNamespace(Datetime=SimpleNamespace(
        now=lambda: SimpleNamespace(strftime=lambda fmt: "2026-10-15 12:00:00")))
    company = SimpleNamespace(name='Company"\nSIZE 999 mm, 999 mm')
    selected = SimpleNamespace(
        id=71, company_id=company, branch_id=False, printer_protocol=protocol,
        printer_id='Printer"\nPRINT 99,99', document_type="label", ensure_one=lambda: None,
    )

    class Router(production):
        env = SimpleNamespace(company=company)

        def _gateway_config(self, selected_company):
            assert selected_company is company
            return True

        def route_raw_command(self, data, **kwargs):
            assert data == ticket
            assert kwargs == dict(protocol=protocol, binding=selected, company=company,
                                  document_type="label")
            return {"status": "submitted", "job_id": 91}

    assert Router().route_test_page(selected) == {"status": "submitted", "job_id": 91}
