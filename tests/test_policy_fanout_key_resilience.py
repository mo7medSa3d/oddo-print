"""Automated print dispatch must not be silently skipped by key computation.

Production `effective_target_key` is executed directly (AST-extracted, as in
the existing F-series tests). Only ORM/routing boundaries are stubs; no Odoo,
PostgreSQL or physical printer is involved.

Root cause: `effective_target_key` called `resolve_binding`, which enforces the
active-company contract and raises when a root-company operator or the cron user
validates a branch-scoped record. That exception escaped into
`dispatch_for_record`'s catch-all, so no Intent was ever created and the
delivery slip / invoice / label was never printed — with only a log line as
evidence. The Intent layer already re-scopes the environment for this case, so
key computation must not be the thing that aborts the print.
"""
import ast
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

MODELS = Path(__file__).resolve().parents[1] / 'odoo_addons/print_gateway/models'


class ValidationError(Exception):
    pass


class Savepoint:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Ref(SimpleNamespace):
    def __bool__(self):
        return True

    def __len__(self):
        return 1


def ref(model_name, pk, **kw):
    kw.setdefault('id', pk)
    kw.setdefault('_name', model_name)
    return Ref(**kw)


def production_methods(file, names):
    path = MODELS / file
    tree = ast.parse(path.read_text(encoding='utf-8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef)
                and any(isinstance(m, ast.FunctionDef) and m.name in names for m in n.body))
    selected = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in selected} == set(names), 'missing production method'
    for node in selected:
        node.decorator_list = []
    expression = ast.ClassDef(name='Production', bases=[], keywords=[], body=selected, decorator_list=[])
    ns = {
        'ValidationError': ValidationError,
        'AccessError': ValidationError,
        '_': lambda msg: msg,
        '_logger': logging.getLogger('test-policy-fanout-key'),
    }
    exec(compile(ast.fix_missing_locations(ast.Module(body=[expression], type_ignores=[])), str(path), 'exec'), ns)
    return ns['Production']


Policy = production_methods('print_policy.py', ['_policy_target_binding_id', 'effective_target_key'])

ROOT_COMPANY = ref('res.company', 1, parent_id=False)
BRANCH = ref('res.company', 2, parent_id=ROOT_COMPANY)
RECORD = ref('stock.picking', 500, company_id=BRANCH)
DECLARED_BINDING = ref('print_gateway.binding', 77, destination_ref=ref('stock.picking.type', 9))


class FakeRouter:
    def __init__(self, behavior):
        self.behavior = behavior
        self.calls = []

    def resolve_binding(self, **kw):
        self.calls.append(kw)
        if callable(self.behavior):
            return self.behavior(**kw)
        raise self.behavior


class FakeEnv:
    """Stands in for an Odoo Environment for the router lookup only."""

    def __init__(self, company, router):
        self.company = company
        self._router = router
        self.cr = SimpleNamespace(savepoint=lambda: Savepoint())

    def __getitem__(self, key):
        if key == 'print_gateway.print_router':
            return self._router
        raise KeyError(key)


class FakePolicy(Policy):
    def __init__(self, router, action_type='raw'):
        self._router = router
        self.name = 'Auto delivery slip'
        self.action_type = action_type
        self.report_id = ref('ir.actions.report', 31) if action_type == 'report' else False
        self.binding_id = DECLARED_BINDING
        self.raw_protocol = 'escpos'
        self.raw_template = 'TPL'
        self.env = FakeEnv(ROOT_COMPANY, router)

    def ensure_one(self):
        return self


def make_policy(router, action_type='raw'):
    return FakePolicy(router, action_type)


def test_company_mismatch_does_not_abort_key_computation():
    """The regression: resolve_binding raising must not skip the print."""
    router = FakeRouter(ValidationError('routing must use the active company'))
    policy = make_policy(router)

    key = policy.effective_target_key(RECORD)

    assert key[0] == DECLARED_BINDING.id, 'must fall back to the declared binding'
    assert key[1] == 'raw'
    assert key[3] == 'escpos'


def test_key_is_stable_across_calls():
    router = FakeRouter(ValidationError('routing must use the active company'))
    policy = make_policy(router)
    first = policy.effective_target_key(RECORD)
    second = policy.effective_target_key(RECORD)
    assert first == second, 'an unstable dedup key would allow duplicate prints'


def test_successful_resolution_still_uses_the_routed_binding():
    router = FakeRouter(lambda **kw: {'binding_id': 90210})
    policy = make_policy(router)
    key = policy.effective_target_key(RECORD)
    assert key[0] == 90210
    assert router.calls, 'resolution must still be attempted'


def test_report_policy_key_computation_survives_a_routing_failure():
    router = FakeRouter(ValidationError('active company mismatch'))
    policy = make_policy(router, action_type='report')
    key = policy.effective_target_key(RECORD)
    assert key[0] == DECLARED_BINDING.id
    assert key[1] == 'report'
    assert key[2] == 31


def test_policy_without_binding_falls_back_to_false():
    router = FakeRouter(ValidationError('active company mismatch'))
    policy = make_policy(router)
    policy.binding_id = False
    key = policy.effective_target_key(RECORD)
    assert key[0] is False


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-q']))
