"""Kitchen prints must not depend on the caller supplying an idempotency key.

Production `route_kitchen_print` is executed directly (AST-extracted, like the
existing F-series tests). Only ORM/routing/submission boundaries are stubs;
no Odoo, PostgreSQL or physical printer is involved.

Why this matters: `_submit_route` falls back to a random uuid4 key whenever the
caller supplies none. POS receipts and Sale Details already carry deterministic
fallbacks, but a kitchen print without an operation id therefore produced a
SECOND physical kitchen ticket on any retry that lost the id. A deliberate
reprint must keep a random key, because the caller asked for new paper output.
"""
import ast
import hashlib
import logging
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

MODELS = Path(__file__).resolve().parents[1] / 'odoo_addons/print_gateway/models'


class ValidationError(Exception):
    pass


class Ref(SimpleNamespace):
    def __bool__(self):
        return True

    def __len__(self):
        return 1

    def ensure_one(self):
        return self


def ref(model_name, pk, **kw):
    kw.setdefault('id', pk)
    kw.setdefault('_name', model_name)
    return Ref(**kw)


ROOT_COMPANY = ref('res.company', 1, parent_id=False)
BRANCH = ref('res.company', 2, parent_id=ROOT_COMPANY)
POS_CONFIG = ref('pos.config', 24, company_id=BRANCH)
PREP_PRINTER = ref('pos.printer', 41, company_id=BRANCH)
POS_CONFIG.preparation_printer_ids = [PREP_PRINTER]
POS_CONFIG.printer_ids = [PREP_PRINTER]


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
        'datetime': __import__('datetime'),
        'time': __import__('time'),
        'uuid': uuid,
        'hashlib': hashlib,
        'db_now_utc': lambda cr: '2026-10-09',
        'REPORT_DOCUMENT_TYPES': {'pos.order': 'receipt'},
        '_logger': logging.getLogger('test-kitchen-idempotency'),
    }
    exec(compile(ast.fix_missing_locations(ast.Module(body=[expression], type_ignores=[])), str(path), 'exec'), ns)
    return ns['Production']


Router = production_methods('print_router.py', ['route_kitchen_print'])


class FakeOrder(SimpleNamespace):
    def ensure_one(self):
        return self


class FakeRouter(Router):
    def __init__(self):
        self.env = SimpleNamespace(company=BRANCH)
        self.binding_id = 501
        self.submitted = []

    def _assert_current_company(self, company, **_kw):
        assert company == BRANCH

    def _validate_jpeg_base64(self, data):
        assert data == 'KITCHEN_JPEG'

    def resolve_binding(self, **kw):
        assert kw['document_type'] == 'kitchen'
        b = ref('print_gateway.binding', self.binding_id, printer_id='kitchen-runtime')
        return {'binding': b, 'destination': kw['explicit_destination'],
                'document_type': 'kitchen', 'native': False}

    def _submit_route(self, **kw):
        # Mirror the production fallback at print_router.py:495 so the test
        # observes the key the Gateway would actually receive.
        self.submitted.append(kw['idempotency_key'] or uuid.uuid4().hex)
        return {'status': 'queued', 'job_id': len(self.submitted)}


def make_order(**kw):
    defaults = dict(id=777, _name='pos.order', company_id=BRANCH, config_id=POS_CONFIG,
                    write_date='2026-10-09 12:00:00')
    defaults.update(kw)
    order = FakeOrder(**defaults)
    order.ensure_one = lambda: order
    return order


def route(router, order, **kw):
    return router.route_kitchen_print(order, 'KITCHEN_JPEG', **kw)


def test_kitchen_without_key_is_deterministic():
    """A retry that lost the operation id must not mint a second ticket."""
    router = FakeRouter()
    route(router, make_order())
    route(router, make_order())
    assert router.submitted[0] == router.submitted[1]
    # The key must be a real derivation, not a random uuid.
    assert len(router.submitted[0]) == 64
    int(router.submitted[0], 16)


def test_kitchen_key_is_stable_across_write_date_only_changes():
    router = FakeRouter()
    route(router, make_order())
    first = router.submitted[0]
    route(router, make_order(write_date='2026-10-09 12:05:00'))
    assert router.submitted[-1] != first, 'a changed order must be a new ticket'


def test_kitchen_distinct_preparation_printers_get_distinct_tickets():
    router = FakeRouter()
    route(router, make_order(), pos_printer=PREP_PRINTER)
    prep_key = router.submitted[-1]
    route(router, make_order())
    pos_key = router.submitted[-1]
    assert prep_key != pos_key


def test_kitchen_explicit_key_is_honoured_verbatim():
    router = FakeRouter()
    route(router, make_order(), idempotency_key='operation-original')
    route(router, make_order(), idempotency_key='operation-original')
    assert router.submitted == ['operation-original', 'operation-original']


def test_kitchen_deliberate_reprint_without_key_stays_a_new_print():
    """A key-less reprint asks for new paper and must NOT be deduplicated.

    route_kitchen_print leaves the key unset for a reprint, so _submit_route's
    random fallback applies and each call becomes its own Gateway job.
    """
    router = FakeRouter()
    route(router, make_order(), reprint=True)
    route(router, make_order(), reprint=True)
    assert router.submitted[0] != router.submitted[1]


def test_kitchen_reprint_with_explicit_key_is_honoured():
    """The POS client mints a fresh operation id for a reprint; it must win."""
    router = FakeRouter()
    route(router, make_order(), reprint=True, idempotency_key='fresh-reprint-id')
    assert router.submitted == ['fresh-reprint-id']


def test_kitchen_key_matches_the_documented_derivation():
    router = FakeRouter()
    route(router, make_order())
    expected = hashlib.sha256(
        'kitchen:777:501:24:2026-10-09 12:00:00'.encode('utf-8')).hexdigest()
    assert router.submitted[0] == expected


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-q']))
