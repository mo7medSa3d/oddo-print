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
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(MODELS / filename), "exec"), namespace)
    return namespace[name]


def environment(superuser=False, administrator=False, groups=()):
    return SimpleNamespace(
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
