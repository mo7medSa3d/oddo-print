"""Real controller-method exercises with an isolated Odoo recordset stand-in.

These tests execute the controller's source AST, not a copied implementation.
They are NOT a substitute for an Odoo 19 database/browser asset test.
"""
import ast
import copy
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]
CONTROLLER = ROOT / "odoo_addons19/print_gateway/controllers/runtime_printers.py"


class Forbidden(Exception):
    pass


class ValidationError(Exception):
    pass


class Company:
    def __init__(self, id_, name, parent=None):
        self.id, self.name, self.display_name, self.parent_id = id_, name, name, parent


class Companies:
    def __init__(self, by_id):
        self.by_id = by_id

    def browse(self, id_):
        return SimpleNamespace(exists=lambda: self.by_id.get(id_, False))


class Environment:
    def __init__(self, companies, current):
        self.companies = companies
        self.company = current
        self.model = Companies({company.id: company for company in companies})
        self._ = lambda message: message

    def __getitem__(self, name):
        assert name == "res.company"
        return self.model


def controller_under_test(env):
    tree = ast.parse(CONTROLLER.read_text(encoding="utf8"))
    original = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                    and node.name == "PrintGatewayRuntimePrinterController")
    methods = []
    for node in original.body:
        if isinstance(node, ast.FunctionDef) and node.name in {"setup_context", "_scope"}:
            cloned = copy.deepcopy(node)
            cloned.decorator_list = []
            methods.append(cloned)
    assert len(methods) == 2
    class_node = ast.ClassDef(name="ActualController", bases=[], keywords=[], body=methods,
                              decorator_list=[])
    isolated = ast.fix_missing_locations(ast.Module(body=[class_node], type_ignores=[]))
    namespace = {"Forbidden": Forbidden, "ValidationError": ValidationError,
                 "request": SimpleNamespace(env=env)}
    exec(compile(isolated, str(CONTROLLER), "exec"), namespace)
    klass = namespace["ActualController"]
    klass._require_runtime_admin = lambda self: None
    klass._apply_security_headers = lambda self: None
    klass._get_config = lambda self, company: (SimpleNamespace(id=company.id * 10), company)
    return klass()


def test_runtime_printer_picker_rejects_noncanonical_agent_ids_before_inventory():
    """Compile the actual RPC method, not a mock clone of its acceptance logic."""
    tree = ast.parse(CONTROLLER.read_text(encoding="utf8"))
    original = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                    and node.name == "PrintGatewayRuntimePrinterController")
    method = next(node for node in original.body if isinstance(node, ast.FunctionDef)
                  and node.name == "runtime_printers")
    method = copy.deepcopy(method)
    method.decorator_list = []
    cls = ast.ClassDef(name="RuntimePicker", bases=[], keywords=[], body=[method], decorator_list=[])
    module = ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[]))
    # Exercise the production ID validator, not an unbound AST global.
    policy_source = CONTROLLER.parent.parent / "runtime_policy.py"
    policy_scope = {}
    exec(compile(policy_source.read_text(encoding="utf8"), str(policy_source), "exec"), policy_scope)
    namespace = {
        "is_exact_agent_uid": policy_scope["is_exact_agent_uid"],
        "is_exact_gateway_printer_id": policy_scope.get("is_exact_printer_key"),
        "is_exact_gateway_agent_id": policy_scope["is_exact_agent_uid"],
    }
    exec(compile(module, str(CONTROLLER), "exec"), namespace)
    picker = namespace["RuntimePicker"]()
    picker._require_runtime_admin = lambda: None
    picker._apply_security_headers = lambda: None
    picker._scope = lambda _company, _branch: (object(), None)

    def must_not_read_inventory(_company):
        raise AssertionError("malformed remote Agent identity reached privileged printer inventory")
    picker._get_config = must_not_read_inventory

    for raw_id in (" agt-one ", "agt-one\n", "\ufeffagt-one",
                   "agt-one\x00", "\ud800", "x" * 121):
        result = picker.runtime_printers(agent_id=raw_id)
        assert result == {"enabled": True, "selectedAgentId": False, "printers": []}

    # A correctly shaped exact Agent ID must still pass input validation and
    # reach the normal scoped configuration/assignment authority, not be
    # silently treated as a malformed identity.
    calls = []
    def no_config(_company):
        calls.append(True)
        return (False, None)
    picker._get_config = no_config
    assert picker.runtime_printers(agent_id="agt_12345678") == {
        "enabled": False, "selectedAgentId": False, "printers": [],
    }
    assert calls == [True]


def test_duplicate_names_and_user_supplied_suffixes_never_collide():
    a = Company(1, "My Company")
    b = Company(2, "My Company")
    c = Company(3, "My Company (#2)")
    controller = controller_under_test(Environment([a, b, c], a))
    result = controller.setup_context()
    labels = [scope["name"] for scope in result["scopes"]]
    assert len(set(name.casefold() for name in labels)) == 3
    assert [scope["id"] for scope in result["scopes"]] == [1, 2, 3]
    assert all(scope["companyId"] == scope["id"] for scope in result["scopes"])


def test_four_same_name_authorized_branches_preserve_exact_routing_identities():
    root = Company(101, "My Company")
    branch_a = Company(201, "My Company", root)
    branch_b = Company(202, "My Company", root)
    branch_c = Company(203, "My Company", root)
    nested = Company(301, "My Company", branch_a)
    env = Environment([root, branch_a, branch_b, branch_c, nested, branch_a], root)
    result = controller_under_test(env).setup_context()
    scopes = result["scopes"]
    assert [row["id"] for row in scopes] == [101, 201, 202, 203, 301]
    assert len({row["name"].casefold() for row in scopes}) == 5
    assert [(row["companyId"], row["branchId"]) for row in scopes] == [
        (101, False), (101, 201), (101, 202), (101, 203), (101, 301),
    ]
    assert "My Company / My Company / My Company" in scopes[-1]["name"]
    assert scopes[-1]["assignable"] is False
    assert all(row.get("assignable", True) for row in scopes[:-1])


@pytest.mark.parametrize("bad", [True, 1.8, "1.0", " 1", -1, "", [], {}, 2**70])
def test_explicit_company_scope_rejects_ambiguous_rpc_ids(bad):
    root = Company(1, "Root")
    controller = controller_under_test(Environment([root], root))
    with pytest.raises(Forbidden):
        controller._scope(company_id=bad)


def test_explicit_branch_scope_rejects_fractional_rpc_ids():
    root, branch = Company(1, "Root"), Company(2, "Branch")
    branch.parent_id = root
    controller = controller_under_test(Environment([root, branch], root))
    with pytest.raises(Forbidden):
        controller._scope(company_id=1, branch_id=2.9)
    assert controller._scope(company_id="1", branch_id="2") == (root, branch)


def test_native_agent_picker_tracks_saved_agent_not_implicit_first_scope():
    source = (ROOT / "odoo_addons19/print_gateway/static/src/components/runtime_agent_field.js").read_text()
    assert 't-att-selected="agent.id === selectedAgentUid"' in source
    assert 'this.state.agents = [];' in source
    assert 'this.state.branchId = branchId;' in source
    assert "updateData.printer_id = false" in source


def test_native_printer_picker_tracks_saved_printer_for_exact_agent():
    source = (ROOT / "odoo_addons19/print_gateway/static/src/components/runtime_printer_field.js").read_text()
    assert 't-att-selected="printer.id === props.record.data[props.name]"' in source
    assert 't-att-disabled="state.loading || !state.agentId"' in source
    assert "this.companyId, this.branchId, this.agentId, this.destinationType" in source
    assert "/print_gateway/runtime-printers" in source
