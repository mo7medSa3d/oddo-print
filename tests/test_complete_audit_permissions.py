"""Execute actual permission methods without importing an unavailable Odoo registry."""
import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "odoo_addons/print_gateway/models"


class AccessError(Exception):
    pass


class ValidationError(Exception):
    pass


def source_function(filename, name):
    tree = ast.parse((MODELS / filename).read_text())
    node = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name)
    node.decorator_list = []
    namespace = {"_": lambda text: text, "AccessError": AccessError, "ValidationError": ValidationError}
    # Execute the real dependency in AST-isolated assignment tests. A mock
    # would miss the exact-identity checks used by the actual Odoo model.
    policy_path = MODELS.parent / "runtime_policy.py"
    policy_scope = {}
    exec(compile(policy_path.read_text(encoding="utf-8"), str(policy_path), "exec"), policy_scope)
    namespace["is_exact_agent_uid"] = policy_scope.get("is_exact_agent_uid")
    namespace["is_exact_printer_key"] = policy_scope.get("is_exact_printer_key")
    namespace["is_exact_gateway_printer_id"] = policy_scope.get("is_exact_printer_key")
    namespace["is_exact_gateway_agent_id"] = policy_scope.get("is_exact_agent_uid")
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(MODELS / filename), "exec"), namespace)
    return namespace[name]


def environment(superuser=False, administrator=False, groups=()):
    return SimpleNamespace(
        _=lambda message: message,
        is_superuser=lambda: superuser,
        user=SimpleNamespace(has_group=lambda name: administrator, all_group_ids=SimpleNamespace(ids=list(groups))),
    )


def report(groups):
    value = SimpleNamespace(report_type="qweb-pdf", group_ids=SimpleNamespace(ids=list(groups)))
    value.sudo = lambda: value
    value.exists = lambda: value
    return value


def test_restricted_report_rejects_nonmember_despite_bound_superuser_method():
    check = source_function("binding.py", "_assert_report_usage_access")
    with pytest.raises(AccessError):
        check(environment(groups=[1]), report([2]))


@pytest.mark.parametrize("env,allowed_groups", [(environment(groups=[2]), [2]), (environment(), []), (environment(superuser=True), [2])])
def test_report_permissions_preserve_group_public_and_superuser_access(env, allowed_groups):
    selected = report(allowed_groups)
    assert source_function("binding.py", "_assert_report_usage_access")(env, selected) is selected


def test_runtime_assignment_rejects_nonadministrator():
    check = source_function("runtime_assignment.py", "_check_admin")
    with pytest.raises(AccessError):
        check(SimpleNamespace(env=environment()))


@pytest.mark.parametrize("env", [environment(superuser=True), environment(administrator=True)])
def test_runtime_assignment_preserves_authorized_administration(env):
    source_function("runtime_assignment.py", "_check_admin")(SimpleNamespace(env=env))


class _RecordSet(list):
    def __init__(self, rows, env):
        super().__init__(rows)
        self.env = env


def test_print_config_check_admin_rejects_non_system_admin():
    check_admin = source_function("print_config.py", "_check_admin")
    check_root = source_function("print_config.py", "_check_root_company")
    root = SimpleNamespace(id=1, parent_id=False, display_name="Root Co")
    branch = SimpleNamespace(id=2, parent_id=root, display_name="Branch A")

    # Non-admin attempting to mutate print config
    user_env = SimpleNamespace(
        is_superuser=lambda: False,
        companies=[root],
        user=SimpleNamespace(has_group=lambda name: False, company_ids=[root]),
    )
    with pytest.raises(AccessError):
        check_admin(_RecordSet([SimpleNamespace(company_id=root)], user_env))

    # Branch company assigned as root company
    with pytest.raises(ValidationError):
        check_root(_RecordSet([SimpleNamespace(company_id=branch)], user_env))

    # Legitimate root admin
    admin_env = SimpleNamespace(
        is_superuser=lambda: False,
        companies=[root],
        user=SimpleNamespace(has_group=lambda name: name == "base.group_system", company_ids=[root]),
    )
    check_admin(_RecordSet([SimpleNamespace(company_id=root)], admin_env))
    check_root(_RecordSet([SimpleNamespace(company_id=root)], admin_env))


def test_print_policy_hierarchy_enforces_company_and_branch_boundaries():
    check = source_function("print_policy.py", "_check_hierarchy")
    root = SimpleNamespace(id=1, parent_id=False)
    branch_a = SimpleNamespace(id=2, parent_id=root)
    branch_b = SimpleNamespace(id=3, parent_id=root)

    # Malicious: branch_a admin attempting company-wide (branch_id=False) or sibling branch_b policy
    branch_a_env = SimpleNamespace(
        is_superuser=lambda: False,
        companies=[branch_a],
        user=SimpleNamespace(company_ids=[branch_a]),
    )
    for forbidden_branch in (False, branch_b):
        records = _RecordSet(
            [SimpleNamespace(company_id=root, branch_id=forbidden_branch, binding_id=False)],
            branch_a_env,
        )
        with pytest.raises(ValidationError):
            check(records)

    # Legitimate: branch_a admin managing branch_a policy
    legit_branch_records = _RecordSet(
        [SimpleNamespace(company_id=root, branch_id=branch_a, binding_id=False)],
        branch_a_env,
    )
    check(legit_branch_records)

    # Legitimate: root admin managing company-wide policy or newly created child branch policy
    root_admin_env = SimpleNamespace(
        is_superuser=lambda: False,
        companies=[root],
        user=SimpleNamespace(company_ids=[root, branch_a, branch_b]),
    )
    for allowed_branch in (False, branch_a, branch_b):
        records = _RecordSet(
            [SimpleNamespace(company_id=root, branch_id=allowed_branch, binding_id=False)],
            root_admin_env,
        )
        check(records)


def test_runtime_assignment_enforces_active_and_assigned_companies():
    check = source_function("runtime_assignment.py", "_check_assignment")
    root = SimpleNamespace(id=1, parent_id=False)
    branch_a = SimpleNamespace(id=2, parent_id=root)
    branch_b = SimpleNamespace(id=3, parent_id=root)

    agent_obj = SimpleNamespace(active=True, agent_uid="agt_fixture1", company_id=root)
    # Malicious: only branch_a is active in env.companies, attempting root-wide or branch_b assignment
    branch_a_active_env = SimpleNamespace(
        is_superuser=lambda: False,
        companies=[branch_a],
        user=SimpleNamespace(company_ids=[root, branch_a, branch_b]),
    )
    for forbidden_branch in (False, branch_b):
        records = _RecordSet(
            [SimpleNamespace(company_id=root, branch_id=forbidden_branch, agent_id=agent_obj)],
            branch_a_active_env,
        )
        with pytest.raises(ValidationError):
            check(records)

    # Legitimate: branch_a active in env.companies and user.company_ids
    check(
        _RecordSet(
            [SimpleNamespace(company_id=root, branch_id=branch_a, agent_id=agent_obj)],
            branch_a_active_env,
        )
    )

    # Legitimate: root company active in env.companies and user.company_ids
    root_active_env = SimpleNamespace(
        is_superuser=lambda: False,
        companies=[root],
        user=SimpleNamespace(company_ids=[root, branch_a]),
    )
    for allowed_branch in (False, branch_a):
        check(
            _RecordSet(
                [SimpleNamespace(company_id=root, branch_id=allowed_branch, agent_id=agent_obj)],
                root_active_env,
            )
        )


def test_binding_runtime_scope_enforces_user_company_ids_and_active_companies():
    source = (ROOT / "odoo_addons/print_gateway/models/binding.py").read_text(encoding="utf-8")
    assert 'user_companies = getattr(getattr(self.env, "user", None), "company_ids", None)' in source
    assert "record.company_id not in user_companies" in source
    assert "record.branch_id not in user_companies" in source
    assert "no overrides needed" in source
