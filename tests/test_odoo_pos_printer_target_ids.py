"""Execute the real POS printer-selection RPC methods against exact Odoo IDs.

The browser's no-preparation-printer sentinel is None/False. An explicitly
supplied malformed or zero ID cannot select a different POS/default printer.
"""
import ast
import copy
from pathlib import Path
from types import MethodType, SimpleNamespace

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/models/pos_order.py"


class ValidationError(Exception):
    pass


def production_method(name):
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
               and node.name == "PosOrderGatewayPrinting")
    node = copy.deepcopy(next(node for node in cls.body
               if isinstance(node, ast.FunctionDef) and node.name == name))
    node.decorator_list = []
    # The method uses a top-level helper. Compile the REAL selector beside it
    # instead of replacing it or leaving an unresolved Python global.
    helper = copy.deepcopy(next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                               and n.name == "_exact_pos_printer_id"))
    scope = {"ValidationError": ValidationError, "_": lambda message: message}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[helper, node], type_ignores=[])), str(SOURCE), "exec"), scope)
    return scope[name]


def fixture():
    selected = SimpleNamespace(id=31, product_categories_ids=[1])
    called = []

    class Registry(dict):
        def __getitem__(self, name):
            if name == "pos.printer":
                class PrinterModel:
                    def browse(self, target):
                        called.append(("browse", target))
                        return SimpleNamespace(exists=lambda: selected if target == 31 else False)
                return PrinterModel()
            if name == "print_gateway.print_router":
                class Router:
                    def route_kitchen_print(self, order, image, **kwargs):
                        called.append(("print", kwargs["pos_printer"]))
                        return {"status": "queued"}
                    def resolve_binding(self, **kwargs):
                        called.append(("inspect", kwargs["explicit_destination"]))
                        return {"binding": True}
                return Router()
            raise AssertionError("Unexpected external model " + name)

    company = SimpleNamespace(id=7)
    config = SimpleNamespace(printer_ids=[selected], company_id=company)
    env = Registry()
    env.company = company
    self = SimpleNamespace(
        ensure_one=lambda: None,
        check_access=lambda scope: scope == "read",
        config_id=config,
        company_id=company,
        env=env,
    )
    self._gateway_active_company = MethodType(production_method("_gateway_active_company"), self)
    return self, selected, called


@pytest.mark.parametrize("invalid", [
    0, -1, True, 1.0, "0", "", "31 ", "31", [], {}, "31e0",
])
@pytest.mark.parametrize("method", ["action_print_gateway_kitchen", "has_gateway_kitchen_binding"])
def test_explicit_invalid_printer_selection_never_falls_back_to_default(method, invalid):
    receiver, _selected, called = fixture()
    fn = production_method(method)
    with pytest.raises(ValidationError, match="Preparation Printer|printer"):
        if method == "action_print_gateway_kitchen":
            fn(receiver, "valid raster", pos_printer_id=invalid)
        else:
            fn(receiver, pos_printer_id=invalid)
    assert called == [], "No printer inventory or print routing may occur for an invalid ID"


@pytest.mark.parametrize("unset", [None, False])
def test_intentionally_unselected_preparation_printer_keeps_pos_fallback(unset):
    receiver, _selected, called = fixture()
    action = production_method("action_print_gateway_kitchen")
    assert action(receiver, "valid raster", pos_printer_id=unset) == {"status": "queued"}
    assert called == [("print", False)]


def test_exact_positive_preparation_printer_resolves_only_selected_record():
    receiver, printer, called = fixture()
    action = production_method("action_print_gateway_kitchen")
    assert action(receiver, "valid raster", pos_printer_id=31) == {"status": "queued"}
    assert called == [("browse", 31), ("print", printer)]
