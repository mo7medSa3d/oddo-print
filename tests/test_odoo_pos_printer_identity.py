"""Exercise the actual Odoo POS printer ID guard without importing an Odoo server.

The selector must never coerce a boolean/float/string-with-space into another
preparation printer or silently fall back to the POS default printer.
"""
import ast
from pathlib import Path

import pytest


SOURCE = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/models/pos_order.py"


class ValidationError(Exception):
    pass


def actual_exact_pos_printer_id():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    function = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_exact_pos_printer_id"
    )
    scope = {"ValidationError": ValidationError, "_": lambda message: message}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])),
                 str(SOURCE), "exec"), scope)
    return scope["_exact_pos_printer_id"]


@pytest.mark.parametrize("value,expected", [
    (None, None), (False, None), (1, 1), (2147483647, 2147483647),
    (2**63 - 1, 2**63 - 1),
])
def test_exact_pos_preparation_id_accepts_only_real_exact_ids(value, expected):
    assert actual_exact_pos_printer_id()(value) == expected


@pytest.mark.parametrize("value", [
    True, 0, -1, 1.0, 1.9, "7", "0007", " ", "", " 7", "7 ", "+7", "-7",
    "٧", "1.0", "1e3", "0x7", "0", str(2**63), 2**63,
    [], {}, [7], "\uFEFF7",
])
def test_invalid_explicit_printer_id_never_falls_back_or_coerces(value):
    with pytest.raises(ValidationError):
        actual_exact_pos_printer_id()(value)


def test_both_pos_kitchen_routes_guard_the_selection_before_browse():
    source = SOURCE.read_text(encoding="utf-8")
    assert source.count("_exact_pos_printer_id(pos_printer_id)") == 2
    assert "if selected_printer_id is not None:" in source
    assert "browse(selected_printer_id).exists()" in source
    assert "browse(pos_printer_id).exists()" not in source
