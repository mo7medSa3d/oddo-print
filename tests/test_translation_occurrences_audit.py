"""Exercise source extraction and Odoo import-reference validation without Odoo."""
from pathlib import Path
import runpy
import tempfile

CHECKER = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/check-odoo-translations.py"))


def test_code_references_require_numeric_line_and_typed_models():
    valid = CHECKER["valid_occurrence"]
    assert valid("code:addons/print_gateway/models/binding.py:0")
    assert valid("model:ir.model.fields,field_description:print_gateway.field_model__name")
    assert valid("model_terms:ir.ui.view,arch_db:print_gateway.view_binding")
    assert not valid("models/binding.py")
    assert not valid("code:addons/print_gateway/models/binding.py")
    assert not valid("code:addons/print_gateway/models/binding.py:NaN")


def test_extractor_covers_fields_selections_and_decoded_view_terms():
    with tempfile.TemporaryDirectory() as directory:
        addon = Path(directory) / "print_gateway"
        addon.mkdir()
        (addon / "model.py").write_text("class Example:\n    _name = 'print_gateway.example'\n    _description = 'Example model'\n    mode = fields.Selection([('pdf', 'PDF mode')], string='Output mode', help='Choose a mode')\n    name = fields.Char()\n", encoding="utf-8")
        (addon / "view.xml").write_text('<odoo><record id="view_example" model="ir.ui.view"><field name="arch" type="xml"><form string="Connection &amp; Printing"><p>Inspect the printer</p><span t-translation="off">TECHNICAL</span></form></field></record></odoo>', encoding="utf-8")
        terms = CHECKER["extract_occurrences"](addon)
        assert terms["Output mode"] == {"model:ir.model.fields,field_description:print_gateway.field_print_gateway_example__mode"}
        assert terms["PDF mode"] == {"model:ir.model.fields.selection,name:print_gateway.selection__print_gateway_example__mode__pdf"}
        assert terms["Name"] == {"model:ir.model.fields,field_description:print_gateway.field_print_gateway_example__name"}
        assert terms["Connection & Printing"] == {"model_terms:ir.ui.view,arch_db:print_gateway.view_example"}
        assert "Inspect the printer" in terms
        assert "TECHNICAL" not in terms
