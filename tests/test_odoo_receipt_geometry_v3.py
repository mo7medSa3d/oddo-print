"""Run the actual Odoo geometry routing methods with an isolated runtime lookup.

These are software contract tests, not physical printer acceptance.
"""
import ast
import importlib.util
import json
from pathlib import Path
from types import MethodType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "odoo_addons/print_gateway/models/print_router.py"


class ValidationError(Exception):
    pass


def geometry(dpi=203, dots=576):
    return {
        "version": 1, "source": "validated_profile", "validation": "configured",
        "observed_at": "2026-10-24T00:00:00Z", "printer_id": "selected-printer",
        "config_fingerprint": "a" * 64, "printable_width_dots": dots,
        "dpi_x": dpi, "dpi_y": dpi, "paper_width_mm": 80,
    }


def router():
    scope = {"ValidationError": ValidationError, "_": lambda message: message}
    helper = ROOT / "odoo_addons/print_gateway/printer_geometry.py"
    if helper.exists():
        spec = importlib.util.spec_from_file_location("odoo_printer_geometry_under_test", helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        scope["validated_receipt_geometry"] = module.validated_receipt_geometry
    tree = ast.parse(SOURCE.read_text())
    owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "PrintGatewayRouter")
    selected = []
    for node in owner.body:
        if isinstance(node, ast.FunctionDef) and node.name in {"_receipt_width_for_route", "_receipt_geometry_for_route", "_receipt_image_payload"}:
            node.decorator_list = []
            selected.append(node)
    exec(compile(ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[])), str(SOURCE), "exec"), scope)
    result = SimpleNamespace()
    for node in selected:
        setattr(result, node.name, MethodType(scope[node.name], result))
    return result


def route(profile):
    printer = {"id": "selected-printer", "printableWidthDots": profile.get("printable_width_dots") if isinstance(profile, dict) else None,
               "capabilities": {"geometry": profile}}
    return {"binding": SimpleNamespace(printer_id="selected-printer", _validate_runtime_target=lambda **_kw: printer)}


@pytest.mark.parametrize("dpi,dots", [(203, 576), (300, 851), (600, 1702)])
def test_route_uses_actual_selected_width_at_each_dpi(dpi, dots):
    assert router()._receipt_width_for_route(route(geometry(dpi, dots))) == dots


@pytest.mark.parametrize("candidate", [None, {}, {"printable_width_dots": 576},
    {**geometry(), "printer_id": "other-printer"}, {**geometry(), "dpi_x": 0},
    {**geometry(), "paper_width_mm": 40}, {**geometry(), "config_fingerprint": ""}])
def test_unknown_or_unbound_geometry_never_invents_a_default(candidate):
    with pytest.raises(ValidationError, match="geometry|measurements"):
        router()._receipt_width_for_route(route(candidate))


def test_missing_receipt_binding_cannot_invent_geometry():
    with pytest.raises(ValidationError, match="binding|geometry|measurements"):
        router()._receipt_width_for_route({})


def test_image_payload_retains_exact_original_fingerprint_and_bytes():
    profile = geometry()
    payload = router()._receipt_image_payload(route(profile), "EXACT_ORIGINAL_JPEG", profile["config_fingerprint"])
    assert payload == {"type": "image", "encoding": "base64", "data": "EXACT_ORIGINAL_JPEG",
                       "geometry_fingerprint": profile["config_fingerprint"]}


@pytest.mark.parametrize("fingerprint", [None, "", "b" * 64, 1])
def test_same_width_but_changed_geometry_cannot_reuse_a_formatted_receipt(fingerprint):
    with pytest.raises(ValidationError, match="geometry changed|geometry reference"):
        router()._receipt_image_payload(route(geometry()), "EXACT_ORIGINAL_JPEG", fingerprint)


def test_driver_image_requires_paper_media_but_direct_raster_typography_does_not():
    profile = geometry()
    del profile["paper_width_mm"]
    candidate = route(profile)
    printer = candidate["binding"]._validate_runtime_target()
    printer.update(connectionType="usb", protocol="escpos")
    profile["raster_command"] = "gs_v_0"
    assert router()._receipt_width_for_route(candidate) == 576
    printer.update(connectionType="spooler", protocol="spooler")
    with pytest.raises(ValidationError, match="geometry"):
        router()._receipt_width_for_route(candidate)


def load_geometry_module():
    path = ROOT / "odoo_addons/print_gateway/printer_geometry.py"
    spec = importlib.util.spec_from_file_location("odoo_shared_geometry_contract", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SHARED_CASES = json.loads((ROOT / "contracts/printer-geometry-fixtures.json").read_text())["geometryCases"]


@pytest.mark.parametrize("field", ["paper_width_mm", "paper_height_mm"])
def test_adversarial_arbitrary_precision_paper_dimension_fails_closed(field):
    """JSON-backed printer profiles must never crash Odoo on enormous ints.

    Reject the untrusted measurement before converting arbitrary-precision
    Python integers to C doubles inside math.isfinite().
    """
    candidate = geometry()
    candidate[field] = 10 ** 1000
    assert load_geometry_module().validated_printer_geometry(candidate, "selected-printer") is None


@pytest.mark.parametrize("case", SHARED_CASES, ids=lambda case: case["name"])
def test_python_matches_shared_gateway_agent_geometry_vectors(case):
    expected = case.get("expected", {})
    result = load_geometry_module().validated_printer_geometry(
        case["geometry"], expected.get("printerId"), expected.get("fingerprint"),
    )
    assert bool(result) is case["valid"]
    if result:
        assert result["printable_width_dots"] == case["rasterWidth"]
