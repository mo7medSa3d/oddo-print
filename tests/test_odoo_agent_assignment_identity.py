"""Exercise real Odoo runtime-agent assignment methods without an Odoo registry.

Only ORM lookup/storage is substituted. A saved malformed Agent ID must never
be trimmed into authority for another exact Gateway Agent/branch.
"""
import ast
import copy
import importlib.util
from pathlib import Path
from types import MethodType, SimpleNamespace

import pytest

ADDON = Path(__file__).resolve().parents[1] / "odoo_addons19/print_gateway"


class ValidationError(Exception):
    pass


def production_methods():
    source = ADDON / "models/runtime_assignment.py"
    tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    klass = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                 and node.name == "PrintGatewayRuntimeAgentAssignment")
    names = {"assigned_agent_ids", "is_agent_assigned", "_check_assignment"}
    methods = [copy.deepcopy(node) for node in klass.body
               if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in methods} == names
    for method in methods:
        method.decorator_list.clear()
    spec = importlib.util.spec_from_file_location("odoo_agent_assignment_exact_policy", ADDON / "runtime_policy.py")
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    scope = {
        "_": lambda text: text, "ValidationError": ValidationError,
        "is_exact_agent_uid": policy.is_exact_agent_uid,
        "is_exact_printer_key": policy.is_exact_printer_key,
        "is_exact_gateway_printer_id": policy.is_exact_printer_key,
        "is_exact_gateway_agent_id": policy.is_exact_agent_uid,
    }
    exec(compile(ast.fix_missing_locations(ast.Module(body=methods, type_ignores=[])), str(source), "exec"), scope)
    return scope


class Company(SimpleNamespace):
    def exists(self):
        return self

    def __len__(self):
        return 1


def fake_assignment(stored):
    methods = production_methods()
    company = Company(id=7, parent_id=False)
    class Model:
        def sudo(self):
            return self

        def search(self, domain):
            assert ("company_id", "=", 7) in domain
            return [SimpleNamespace(agent_id=SimpleNamespace(agent_uid=value, active=True)) for value in stored]
    model = Model()
    model.assigned_agent_ids = MethodType(methods["assigned_agent_ids"], model)
    model.is_agent_assigned = MethodType(methods["is_agent_assigned"], model)
    return model, company


def checked_assignment(raw):
    method = production_methods()["_check_assignment"]
    company = Company(id=7, parent_id=False)
    environment = SimpleNamespace(
        is_superuser=lambda: True, companies=[company],
        user=SimpleNamespace(company_ids=[company]),
    )
    spec = importlib.util.spec_from_file_location("odoo_policy", ADDON / "runtime_policy.py")
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    agent = None
    if isinstance(raw, str) and policy.is_exact_agent_uid(raw):
        agent = SimpleNamespace(agent_uid=raw, active=True, company_id=company)
    class Rows(list):
        env = environment
    return method(Rows([SimpleNamespace(
        company_id=company, branch_id=False, agent_id=agent,
    )]))


@pytest.mark.parametrize("malformed", [
    " agent", "agent ", "\ufeffagent", "agent\ufeff",
    "agent\x00other", "agent\u0085other", "\ud800",
    "é" * 61, "x" * 121,
])
def test_assignment_validator_refuses_identity_that_gateway_cannot_execute(malformed):
    with pytest.raises(ValidationError, match="(?i)agent"):
        checked_assignment(malformed)


def test_lookup_never_upgrades_a_padded_stored_agent_to_another_exact_agent():
    model, company = fake_assignment([" agent ", "agt_canon001"])
    assert model.assigned_agent_ids(company) == {"agt_canon001"}
    assert model.is_agent_assigned(company, False, "agt_fixture1") is False
    assert model.is_agent_assigned(company, False, " agent ") is False
    assert model.is_agent_assigned(company, False, "agt_canon001") is True


def test_lookup_rejects_malformed_caller_even_when_exact_stored_agent_exists():
    model, company = fake_assignment(["agt_fixture1"])
    for malformed in (" agent", "agent ", "agent\x00suffix", "\ufeffagent", "a" * 121):
        assert model.is_agent_assigned(company, False, malformed) is False
    assert model.is_agent_assigned(company, False, "agt_fixture1") is True


def test_unicode_ids_cannot_alias_an_exact_gateway_agent():
    with pytest.raises(ValidationError, match="(?i)agent"):
        checked_assignment("وكيل-1")
    model, company = fake_assignment(["وكيل-1", "é" * 60, "agt_canon001"])
    assert model.assigned_agent_ids(company) == {"agt_canon001"}
    assert model.is_agent_assigned(company, False, "وكيل-1") is False
    assert model.is_agent_assigned(company, False, "agt_canon001") is True
