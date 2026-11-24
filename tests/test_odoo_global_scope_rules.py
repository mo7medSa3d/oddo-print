"""Exercise the shipped scope domains under Odoo's global-AND/group-OR rules.

Native coverage lives in test_branch_activity_visibility; this narrow offline
characterization keeps an additional permissive group rule from opening scopes.
"""
import ast
from pathlib import Path
from types import SimpleNamespace
import xml.etree.ElementTree as ET

import pytest


SECURITY = Path(__file__).resolve().parents[1] / "odoo_addons/print_gateway/security/security.xml"
RULES = ET.parse(SECURITY).findall("record[@model='ir.rule']")
MODELS = sorted({rule.find("field[@name='model_id']").attrib["ref"] for rule in RULES})


def _matches(domain, company):
    tokens = iter(domain)

    def consume():
        token = next(tokens)
        if token == "|":
            left, right = consume(), consume()
            return left or right
        if token == "&":
            left, right = consume(), consume()
            return left and right
        if token == "!":
            return not consume()
        field, operator, expected = token
        value = company
        for component in field.split(".")[1:]:
            value = getattr(value, component)
        value = value.id if isinstance(value, SimpleNamespace) else value
        if operator == "in":
            return bool(set(value) & set(expected)) if isinstance(value, list) else value in expected
        assert operator == "="
        return value == expected

    results = []
    while True:
        try:
            results.append(consume())
        except StopIteration:
            return all(results)


@pytest.mark.parametrize("model", MODELS)
@pytest.mark.parametrize("operation", ["read", "write", "create", "unlink"])
def test_permissive_group_rule_cannot_expose_foreign_company(model, operation):
    # A user has a legitimate extra role whose rule grants all records. Odoo
    # ORs group rules, then ANDs that result with every applicable global rule.
    grouped = [True]
    global_results = []
    foreign = SimpleNamespace(id=20, parent_id=21, child_ids=[22])
    for rule in RULES:
        if rule.find("field[@name='model_id']").attrib["ref"] != model:
            continue
        permission = rule.find("field[@name='perm_%s']" % operation)
        if permission is not None and not ast.literal_eval(permission.attrib["eval"]):
            continue
        domain = eval(rule.find("field[@name='domain_force']").text,
                      {"__builtins__": {}}, {"company_ids": [1]})
        # All shipped domains use company_id/branch_id paths. Neither foreign
        # root nor its foreign child has membership in the active company.
        result = _matches(domain, foreign)
        groups = rule.find("field[@name='groups']")
        grouped_rule = groups is not None and any(
            command[0] in (4, 6) and command[-1] for command in eval(
                groups.attrib["eval"], {"__builtins__": {}}, {"ref": lambda value: value},
            )
        )
        (grouped if grouped_rule else global_results).append(result)
    assert not (all(global_results) and any(grouped)), (model, operation)
