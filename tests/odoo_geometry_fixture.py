"""Synthetic geometry and the real pure Odoo validator for isolated tests."""
import importlib.util
from pathlib import Path

_path = Path(__file__).resolve().parents[1] / "odoo_addons19/print_gateway/printer_geometry.py"
_spec = importlib.util.spec_from_file_location("odoo_geometry_fixture_validator", _path)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
validated_printer_geometry = _module.validated_printer_geometry
normalize_receipt_paper_width_mm = _module.normalize_receipt_paper_width_mm


def receipt_geometry(printer_id="printer", dots=576, dpi=203):
    return {"version": 1, "source": "validated_profile", "validation": "configured",
            "observed_at": "2026-10-24T12:00:00Z", "printer_id": printer_id,
            "config_fingerprint": "a" * 64, "printable_width_dots": dots,
            "dpi_x": dpi, "dpi_y": dpi, "paper_width_mm": 80, "raster_command": "gs_v_0"}
