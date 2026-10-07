from pathlib import Path
import importlib.util
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "odoo_addons" / "print_gateway"


def read(rel: str) -> str:
    return (ADDON / rel).read_text(encoding="utf-8")


def load_catalog():
    spec = importlib.util.spec_from_file_location("odoo_i18n_check", ROOT / "scripts" / "check-odoo-translations.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return dict(module.parse_catalog((ADDON / "i18n" / "ar.po").read_text(encoding="utf-8")))


def test_runtime_picker_statuses_classes_and_ids_are_presentation_safe():
    agent = read("static/src/components/runtime_agent_field.js")
    printer = read("static/src/components/runtime_printer_field.js")

    assert 'id="o_pg_agent_error"' not in agent
    assert 'id="o_pg_printer_error"' not in printer
    assert 't-att-id="errorId"' in agent
    assert 't-att-id="errorId"' in printer
    assert "isolateIdentifier(agent.id)" in agent
    assert "isolateIdentifier(props.record.data[props.name])" in printer
    assert "\\u2068" in agent and "\\u2069" in agent
    assert "\\u2068" in printer and "\\u2069" in printer
    assert "statusLabel(agent)" in agent
    assert "statusLabel(printer)" in printer
    assert "deviceClassLabel(printer.deviceClass)" in printer


def test_arabic_catalog_keeps_canonical_product_terms_and_translates_picker_vocab():
    catalog = load_catalog()
    for msgid, msgstr in catalog.items():
        for token in ("Gateway", "Agent", "Yaseir"):
            if token in msgid:
                assert token in msgstr, f"{token} was translated in {msgid!r}: {msgstr!r}"

    expected = {
        "online": "متصل",
        "offline": "غير متصل",
        "unknown": "غير معروف",
        "busy": "مشغولة",
        "thermal": "حرارية",
        "laser": "ليزر",
        "inkjet": "نافثة للحبر",
        "label": "ملصقات",
        "other": "أخرى",
        "Used: %s": "المستخدَم: %s",
        "Domain filter must evaluate to a list of criteria.": "يجب أن يُقيَّم مرشّح النطاق إلى قائمة من المعايير.",
    }
    for msgid, msgstr in expected.items():
        assert catalog[msgid] == msgstr


def test_binding_help_matches_preparation_printer_routing_contract():
    root = ET.parse(ADDON / "views" / "binding_views.xml").getroot()
    text = " ".join((node.text or "").strip() for node in root.iter() if (node.text or "").strip())
    assert "POS Receipt does not require an Odoo printer or PDF report." in text
    assert "POS Kitchen / Preparation uses the selected Odoo Preparation Printer for category routing" in text
    assert "POS Receipt and POS Kitchen / Preparation do not require an Odoo printer" not in text
