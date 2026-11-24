"""Execute the production diagnostic renderer's language selection.

The report service is the boundary double; this verifies that an Arabic user
does not silently receive the English-only ASCII PDF path merely because their
company/printer names happen to be Latin text. Native rendered PDFs are checked
separately in the real Odoo runtime.
"""
import textwrap

import pytest

from odoo_geometry_fixture import normalize_receipt_paper_width_mm
from test_f010_report_binding_identity import production_methods


Production = production_methods("print_router.py", ["_generate_test_pdf"])
Production._generate_test_pdf.__globals__.update(
    textwrap=textwrap,
    normalize_receipt_paper_width_mm=normalize_receipt_paper_width_mm,
)


class Report:
    def __init__(self):
        self.calls = []

    def with_context(self, **context):
        self.context = context
        return self

    def _render_qweb_pdf(self, report_ref, **kwargs):
        self.calls.append((self.context, report_ref, kwargs))
        return b"%PDF-1.4\ntranslated report boundary", "pdf"


class Environment(dict):
    def __init__(self, lang, report):
        super().__init__({"ir.actions.report": report})
        self.lang = lang
        self.context = {"lang": lang} if lang else {}


@pytest.mark.parametrize("language", ["ar_001", "ar_SY"])
@pytest.mark.parametrize("width", [None, 58, 80])
def test_arabic_operator_uses_translatable_report_for_ascii_metadata(language, width):
    report = Report()
    router = Production()
    router.env = Environment(language, report)
    pdf = router._generate_test_pdf(
        company_name="Central Cafe", branch_name="Branch 1", printer_name="POS80",
        now_str="2026-10-24 12:00:00", paper_width_mm=width,
    )
    assert len(report.calls) == 1, "Arabic diagnostic labels require the translated Unicode report"
    assert pdf == b"%PDF-1.4\ntranslated report boundary"
    context, ref, values = report.calls[0]
    assert ref == "print_gateway.action_diagnostic_report"
    assert context == {"force_report_rendering": True, "print_gateway_diagnostic_paper_width_mm": width}
    assert values["data"]["company_name"] == "Central Cafe"
    assert values["data"]["paper_width_mm"] == width


@pytest.mark.parametrize("language", [None, "en_US"])
def test_english_ascii_diagnostic_keeps_its_existing_fast_pdf_path(language):
    report = Report()
    router = Production()
    router.env = Environment(language, report)
    pdf = router._generate_test_pdf(
        company_name="Central Cafe", branch_name="Branch 1", printer_name="POS80",
        now_str="2026-10-24 12:00:00", paper_width_mm=80,
    )
    assert report.calls == []
    assert pdf.startswith(b"%PDF-")
    assert b"PRINTER TEST PAGE" in pdf
