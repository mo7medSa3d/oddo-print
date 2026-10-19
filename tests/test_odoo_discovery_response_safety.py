"""Exercise actual discovery boundaries offline; native Odoo remains required."""
import ast
from pathlib import Path
from types import MethodType, SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

ROOT = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway"


class ValidationError(Exception):
    pass


def method(relative, name, namespace):
    tree = ast.parse((ROOT / relative).read_text())
    node = next(node for cls in tree.body if isinstance(cls, ast.ClassDef)
                for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == name)
    node.decorator_list = []
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])),
                 str(ROOT / relative), "exec"), namespace)
    return namespace[name]


def discovery(monkeypatch, agents=None, printers=None):
    config = SimpleNamespace(company_id=1, _gateway_base=lambda **kw: "https://gateway.invalid",
                             _gateway_headers=lambda: {})
    responses = [Mock(status_code=200, content=b"json", json=lambda: {"agents": agents}),
                 Mock(status_code=200, content=b"json", json=lambda: {"printers": printers})]
    get = Mock(side_effect=responses)
    monkeypatch.setattr(requests, "get", get)
    namespace = {"requests": requests, "ValidationError": ValidationError,
                 "Forbidden": ValidationError, "_": lambda text: text,
                 "is_gateway_shared_printer": lambda printer: printer.get("sharedWithGateway", True) is True,
                 "request": SimpleNamespace(env=SimpleNamespace(_=lambda text: text))}
    controller = SimpleNamespace(_require_runtime_admin=lambda: None,
                                 _scope=lambda *args: (1, False),
                                 _get_config=lambda *args: (config, 1),
                                 _assigned_runtime_agent_ids=lambda *args: {"agent"})
    controller.runtime_printers = MethodType(method("controllers/runtime_printers.py", "runtime_printers", namespace), controller)
    controller.runtime_agents = MethodType(method("controllers/runtime_printers.py", "runtime_agents", namespace), controller)
    assignment = SimpleNamespace(is_agent_assigned=lambda *args: True)
    binding = SimpleNamespace(ensure_one=lambda: None, runtime_agent_id="agent", branch_id=False,
                              printer_id="printer", env={"print_gateway.runtime_agent_assignment": assignment},
                              _get_gateway_config=lambda: config)
    binding.validate = MethodType(method("models/binding.py", "_validate_runtime_target", namespace), binding)
    for name in ("_canonical_runtime_printer_protocol", "_runtime_printer_accepts_image"):
        setattr(binding, name, MethodType(method("models/binding.py", name, namespace), binding))
    return controller, binding, get


AGENTS = [{"id": "agent", "lifecycle": "active"}]
PRINTER = {"id": "printer", "lifecycle": "active", "agent": {"id": "agent"},
           "connectionType": "network", "protocol": "escpos"}


@pytest.mark.parametrize("malformed", [17, True, "agent", {"id": "agent"}, None])
def test_invalid_agent_inventory_is_an_actionable_error(monkeypatch, malformed):
    controller, _, get = discovery(monkeypatch, agents=malformed)
    with pytest.raises(ValidationError, match="invalid agent discovery response"):
        controller.runtime_printers(agent_id="agent")
    assert get.call_count == 1
    _, binding, get = discovery(monkeypatch, agents=malformed)
    with pytest.raises(ValidationError, match="Runtime Agent is not found"):
        binding.validate(enforce_destination_compatibility=False)
    assert get.call_count == 1


@pytest.mark.parametrize("malformed", [17, True, "printer", {"id": "printer"}, None])
def test_invalid_printer_inventory_is_an_actionable_error(monkeypatch, malformed):
    _, binding, get = discovery(monkeypatch, agents=AGENTS, printers=malformed)
    with pytest.raises(ValidationError, match="Runtime Printer is not found"):
        binding.validate(enforce_destination_compatibility=False)
    assert get.call_count == 2


@pytest.mark.parametrize("caps, expected", [
    ({}, {}),
    (None, {}),
    (["image"], {}),
    ({"supported_protocols": None}, {"supported_protocols": []}),
    ({"supported_protocols": "escpos"}, {"supported_protocols": []}),
    ({"supported_protocols": []}, {"supported_protocols": []}),
    ({"supported_protocols": [" JPEG ", "image", "jpeg", 42, "bad"]},
     {"supported_protocols": ["jpeg", "image"]}),
    ({"supported_protocols": ["zpl"], "paper_width_mm": 80},
     {"supported_protocols": ["zpl"], "paper_width_mm": 80}),
])
def test_picker_inventory_preserves_absent_versus_restricted_capabilities(monkeypatch, caps, expected):
    controller, binding, _ = discovery(monkeypatch, agents=AGENTS,
                                 printers=[dict(PRINTER, capabilities=caps)])
    result = controller.runtime_printers(agent_id="agent")
    assert len(result["printers"]) == 1
    assert result["printers"][0]["capabilities"] == expected
    assert binding._runtime_printer_accepts_image(result["printers"][0]) == binding._runtime_printer_accepts_image(dict(PRINTER, capabilities=caps))


@pytest.mark.parametrize("route", ["runtime_agents", "runtime_printers"])
@pytest.mark.parametrize("freshness, expected", [
    ([], "missing"),
    ({}, "missing"),
    (True, "missing"),
    (17, "missing"),
    (None, "missing"),
    ("unexpected", "missing"),
    ("fresh", "fresh"),
    ("stale", "stale"),
    ("missing", "missing"),
])
def test_nested_remote_freshness_is_type_safe_in_both_discovery_routes(monkeypatch, route, freshness, expected):
    controller, _, get = discovery(monkeypatch,
        agents=[dict(AGENTS[0], freshness=freshness)],
        printers=[dict(PRINTER, freshness=freshness)])
    if route == "runtime_agents":
        result = controller.runtime_agents()
        assert result["agents"][0]["freshness"] == expected
        assert get.call_count == 1
    else:
        result = controller.runtime_printers(agent_id="agent")
        assert result["printers"][0]["freshness"] == expected
        assert get.call_count == 2


def test_oversized_discovery_responses_fail_closed(monkeypatch):
    controller, _, _ = discovery(monkeypatch, agents=AGENTS, printers=[PRINTER])
    oversized = b"x" * (2 * 1024 * 1024 + 1)
    monkeypatch.setattr(requests, "get", Mock(return_value=Mock(status_code=200, content=oversized, json=lambda: {"agents": AGENTS})))
    with pytest.raises(ValidationError, match="unavailable"):
        controller.runtime_agents()
    with pytest.raises(ValidationError, match="unavailable"):
        controller.runtime_printers(agent_id="agent")
