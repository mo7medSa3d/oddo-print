"""F021/C12: execute actual Gateway-config Odoo methods with opposing host/DB clocks.

ORM/database operations are faked; Odoo 19 and PostgreSQL runtime NOT_RUN.
"""
import ast
import copy
from datetime import datetime, timedelta
from types import SimpleNamespace as NS

import pytest
from test_odoo_config_key_rotation_f015 import (
    config, Config, namespace, method, ModelBase, ADDON,
)
from test_f010_report_binding_identity import production_methods

DB_TIME = datetime(2026, 10, 9, 10, 0)
HOST_FAST = DB_TIME + timedelta(days=1)
HOST_SLOW = DB_TIME - timedelta(days=1)


@pytest.mark.parametrize('host_skew', (HOST_FAST, HOST_SLOW))
@pytest.mark.parametrize('mutation', ('enabled', 'key'))
def test_real_config_write_stamps_revision_with_authoritative_db_time(monkeypatch, host_skew, mutation):
    monkeypatch.setattr(namespace['fields'].Datetime, 'now', lambda: host_skew)
    monkeypatch.setitem(namespace, 'db_now_utc', lambda _cr: DB_TIME)
    record = config()
    if mutation == 'enabled':
        record.write({'enabled': False})
    else:
        record.write({'gateway_api_key': 'NEW-SYNTHETIC-KEY'})
    assert record.pending_sync_started_at == DB_TIME
    assert record.pending_sync_revision == record.enabled_sync_revision


@pytest.mark.parametrize('host_skew', (HOST_FAST, HOST_SLOW))
def test_real_config_create_stamps_authoritative_db_time(monkeypatch, host_skew):
    monkeypatch.setattr(namespace['fields'].Datetime, 'now', lambda: host_skew)
    monkeypatch.setitem(namespace, 'db_now_utc', lambda _cr: DB_TIME)
    class CreateBase:
        def create(self, vals_list):
            return NS(vals=vals_list, _queue_enabled_state_sync=lambda: None)
    local = dict(namespace, CreateBase=CreateBase)
    selected = copy.deepcopy(method('create'))
    model = ast.ClassDef(name='ProductionCreate', bases=[ast.Name(id='CreateBase', ctx=ast.Load())],
                         keywords=[], body=[selected], decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[model], type_ignores=[])),
                 str(ADDON), 'exec'), local)
    producer = local['ProductionCreate']()
    producer.env = NS(company=NS(parent_id=False, id=1), cr=object())
    producer._check_admin = lambda: None
    producer._validate_gateway_url = lambda url: url
    result = producer.create([{'gateway_url': 'https://gateway.example.test', 'enabled': False}])
    assert result.vals[0]['pending_sync_started_at'] == DB_TIME


@pytest.mark.parametrize('host_skew', (HOST_FAST, HOST_SLOW))
def test_real_explicit_stale_reset_uses_same_db_clock(monkeypatch, host_skew):
    monkeypatch.setattr(namespace['fields'].Datetime, 'now', lambda: host_skew)
    method_reset = production_methods('gateway_config.py', ['action_reset_stale_sync_state'])
    method_reset.action_reset_stale_sync_state.__globals__['db_now_utc'] = lambda _cr: DB_TIME
    method_reset.action_reset_stale_sync_state.__globals__['fields'] = namespace['fields']
    record = NS(
        ensure_one=lambda: None, _check_admin=lambda: None,
        env=NS(cr=object()), enabled_sync_revision=8,
        invalidate_recordset=lambda *_args: None,
    )
    record.sudo = lambda: record
    record.with_context = lambda **_kw: record
    record.write = lambda vals: vars(record).update(vals)
    result = method_reset.action_reset_stale_sync_state(record)
    assert record.pending_sync_started_at == DB_TIME
    assert result['tag'] == 'reload'
