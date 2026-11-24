"""Real Odoo geometry and operational-proof parser identity conformance.

Both parsers must reject printer identities the Gateway/Agent cannot execute,
even if a stale or forged inventory report claims the evidence is valid.
Only pure source parsers are loaded; no Odoo DB/physical printer is inferred.
"""
import importlib.util
from datetime import datetime, timezone
from pathlib import Path

import pytest


ADDON = Path(__file__).resolve().parents[1] / "odoo_addons" / "print_gateway"


def load_pure(name):
    source = ADDON / (name + ".py")
    spec = importlib.util.spec_from_file_location("odoo_evidence_contract_" + name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GEOMETRY = load_pure("printer_geometry")
VERIFICATION = load_pure("printer_verification")
NOW = datetime(2026, 10, 28, 0, 0, tzinfo=timezone.utc)


def measured_geometry(identity):
    return {
        "version": 1,
        "source": "validated_profile",
        "validation": "configured",
        "observed_at": "2026-10-28T00:00:00Z",
        "printer_id": identity,
        "config_fingerprint": "a" * 64,
        "printable_width_dots": 576,
        "dpi_x": 203,
        "dpi_y": 203,
        "paper_width_mm": 80,
    }


def operational_proof(identity):
    printer = {
        "id": identity,
        "connectionType": "spooler",
        "protocol": "spooler",
    }
    evidence = {
        "version": 1,
        "verified_at": "2026-10-28T00:00:00Z",
        "printer_id": identity,
        "binding_digest": "b" * 64,
        "logical_queue_key": "b" * 64,
        "method": "windows_queue",
        "identity_strength": "queue",
        "output_medium": "physical",
    }
    return evidence, printer


@pytest.mark.parametrize("identity", [
    "é" * 61,
    "😀" * 31,
    "\ufeffprinter",
    "printer\ufeff",
    "\ud800",
    "\udc00",
    "printer\u0085two",
    " printer",
])
def test_geometry_cannot_admit_unexecutable_printer_identity(identity):
    assert GEOMETRY.validated_printer_geometry(measured_geometry(identity), identity) is None


@pytest.mark.parametrize("identity", [
    "é" * 61,
    "😀" * 31,
    "\ufeffprinter",
    "printer\ufeff",
    "\ud800",
    "\udc00",
    "printer\u0085two",
    " printer",
])
def test_operational_proof_cannot_admit_unexecutable_printer_identity(identity):
    proof, printer = operational_proof(identity)
    assert VERIFICATION.validated_operational_verification(proof, printer, NOW) is None


@pytest.mark.parametrize("identity", [
    "é" * 60,
    "😀" * 30,
    "طابعة-حرارية",
    "queue\ufeffinner",
])
def test_both_parsers_keep_exact_valid_utf8_printer_ids(identity):
    assert GEOMETRY.validated_printer_geometry(measured_geometry(identity), identity)
    proof, printer = operational_proof(identity)
    assert VERIFICATION.validated_operational_verification(proof, printer, NOW)
