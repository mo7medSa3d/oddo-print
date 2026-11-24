"""The source-only translation checker must not process XML DTDs/entities."""
import importlib.util
from pathlib import Path

import pytest


SPEC = importlib.util.spec_from_file_location(
    "translation_security_checker",
    Path(__file__).resolve().parents[1] / "scripts" / "check-odoo-translations.py",
)
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16", "utf-32"])
def test_internal_entity_declaration_is_rejected_before_translation_expansion(tmp_path, encoding):
    source = '<?xml version="1.0" encoding="%s"?><!DOCTYPE odoo [<!ENTITY text "expanded translation">]><odoo><menuitem id="x" name="&text;"/></odoo>' % encoding
    (tmp_path / "view.xml").write_bytes(source.encode(encoding))
    with pytest.raises((ValueError, CHECKER.ET.ParseError)):
        CHECKER.extract_occurrences(tmp_path)


def test_external_subset_is_rejected_even_when_it_defines_no_used_entity(tmp_path):
    (tmp_path / "view.xml").write_text('<!DOCTYPE odoo SYSTEM "file:///unavailable-private-file"><odoo><menuitem id="x" name="Safe"/></odoo>')
    with pytest.raises(ValueError, match="DTD"):
        CHECKER.extract_occurrences(tmp_path)


def test_predefined_xml_entities_and_arabic_remain_supported(tmp_path):
    (tmp_path / "view.xml").write_text('<odoo><menuitem id="x" name="English &amp; العربية"/></odoo>')
    assert "English & العربية" in CHECKER.extract_occurrences(tmp_path)
