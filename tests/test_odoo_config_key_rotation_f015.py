"""Actual Odoo configuration write/postcommit methods, with ORM/HTTP/db stubs.
No installed Odoo, PostgreSQL or real Gateway is represented by these tests.
"""
import ast
import copy
import hmac
import logging
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace as NS

ADDON=Path(__file__).resolve().parents[1]/'odoo_addons/print_gateway/models/gateway_config.py'
TREE=ast.parse(ADDON.read_text())
CONFIG_CLASS=next(n for n in TREE.body if isinstance(n,ast.ClassDef) and n.name=='PrintGatewayConfig')

def method(name):
    node=copy.deepcopy(next(n for n in CONFIG_CLASS.body if isinstance(n,ast.FunctionDef) and n.name==name))
    node.decorator_list=[]
    return node

class ValidationError(Exception): pass
class CredentialKeyUnavailable(Exception): pass
class CredentialDecryptError(Exception): pass
class OldUnauthorized(ValidationError): pass

class Cursor:
    dbname='fixture'
    def __init__(self):self.calls=[];self.postcommit=NS(add=lambda callback:None)
    def execute(self,query,params):self.calls.append((query,params))

class Sql:
    def __init__(self,value):self.value=value
    def format(self,*args):return self
class ModelBase:
    def write(self,values):
        for k,v in values.items():setattr(self,k,v)
        return True

namespace={'ModelBase':ModelBase,'_':lambda v:v,'sql':NS(SQL=Sql,Identifier=lambda v:v),
           'fields':NS(Datetime=NS(now=lambda:datetime(2026,10,9))),
           'ValidationError':ValidationError,'CredentialKeyUnavailable':CredentialKeyUnavailable,
           'CredentialDecryptError':CredentialDecryptError,'_same_credential':lambda a,b:hmac.compare_digest(str(a),str(b)),
           '_same_gateway_endpoint':lambda a,b:a==b,'_OldEndpointUnauthorized':OldUnauthorized,
           '_logger':logging.getLogger('credential-rotation-contract'),
           'db_now_utc':lambda _cr:datetime(2026,10,9),
           'is_encrypted_gateway_api_key':lambda val:str(val).startswith('enc:'),
           'requests':NS(RequestException=ConnectionError)}
cls=ast.ClassDef(name='Config',bases=[ast.Name(id='ModelBase',ctx=ast.Load())],keywords=[],body=[method('write'),method('_pending_disable_credentials'),method('_run_postcommit_enabled_sync'),method('cron_sync_enabled_state')],decorator_list=[])
exec(compile(ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[])),str(ADDON),'exec'),namespace)
Config=namespace['Config']
Config.__iter__=lambda self:iter([self])
Config.flush_recordset=Config.invalidate_recordset=Config.modified=lambda *args,**kwargs:None
Config.ensure_one=Config._check_admin=lambda *args:None
Config.search=lambda self,domain:[self]
Config._probe_gateway_connection=lambda self:True
Config.sudo=Config.with_context=lambda self,**_:self
Config._protected_gateway_api_key=lambda self,key:'enc:'+key
Config._gateway_api_key_plaintext_from_value=lambda self,v:v.removeprefix('enc:')
Config._gateway_api_key_plaintext=lambda self:self._gateway_api_key_plaintext_from_value(self.gateway_api_key)
Config._gateway_base=lambda self,**_:self.gateway_url
Config._validate_gateway_url=lambda self,url:url
Config._persist_gateway_migration_result=lambda self,**kwargs:self.history.append(('migration_result',kwargs))
Config._persist_enabled_sync_result=lambda self,*args,**kwargs:self.history.append(('sync_result',kwargs))
Config._complete_gateway_migration=lambda self,revision:self.history.append(('complete',revision))
Config._sync_pending_gateway_disable=lambda self,**kwargs:self.record_disable(kwargs)
Config._sync_enabled_state_to_gateway=lambda self,*args,**kwargs:self.record_enable(args)
Config._queue_enabled_state_sync=lambda self,pre:self.queued.append({'revision':self.enabled_sync_revision,'pending':self.pending_disable_gateway_api_key,'url':self.pending_disable_gateway_url,'pending_revision':self.pending_disable_revision})

def config(enabled=True,revoked=False,last_sync_error=False):
    c=Config();c.id=1;c.ids=[1];c._table='print_gateway_gateway_config';c.env=NS(context={},cr=Cursor())
    c.enabled=enabled;c.gateway_url='https://gateway.fixture.invalid';c.gateway_api_key='enc:OLD-FIXTURE'
    c.enabled_sync_revision=5;c.last_enabled_sync_revision=5;c.last_enabled_sync_error=last_sync_error
    c.pending_disable_gateway_url=c.pending_disable_gateway_api_key=False;c.pending_disable_revision=-1
    c.pending_sync_revision=-1;c.pending_sync_started_at=False;c.last_test_status='revoked' if revoked else 'connected'
    c.queued=[];c.history=[];c.record_disable=lambda kwargs:c.history.append(('disable',kwargs)) or True
    c.record_enable=lambda args:c.history.append(('enable',args)) or True
    return c

class RotationTests(unittest.TestCase):
    def test_old_key_shutdown_fence_before_new_activation(self):
        c=config();c.write({'gateway_api_key':'NEW-FIXTURE'})
        self.assertEqual(c.gateway_api_key,'enc:NEW-FIXTURE')
        self.assertEqual(c.pending_disable_gateway_url,'https://gateway.fixture.invalid')
        self.assertEqual(c.pending_disable_gateway_api_key,'enc:OLD-FIXTURE')
        self.assertEqual(c.pending_disable_revision,6)
        self.assertEqual(c.queued[-1]['pending'],'enc:OLD-FIXTURE')
        self.assertEqual(c._pending_disable_credentials(),('https://gateway.fixture.invalid','OLD-FIXTURE',6))
    def test_postcommit_old_shutdown_precedes_new_activation(self):
        c=config();c.write({'gateway_api_key':'NEW-FIXTURE'})
        pending=c._pending_disable_credentials()
        self.assertTrue(c._run_postcommit_enabled_sync(gateway_url=c.gateway_url,api_key=c._gateway_api_key_plaintext(),dbname='fixture',revision=6,enabled=True,pending_disable=pending))
        self.assertEqual([x[0] for x in c.history],['disable','enable','complete'])
        self.assertEqual(c.history[0][1]['api_key'],'OLD-FIXTURE')
    def test_failed_shutdown_blocks_enable_and_keeps_fence(self):
        c=config();c.write({'gateway_api_key':'NEW-FIXTURE'})
        c.record_disable=lambda kwargs:c.history.append(('disable_fail',kwargs)) or False
        self.assertFalse(c._run_postcommit_enabled_sync(gateway_url=c.gateway_url,api_key='NEW-FIXTURE',dbname='fixture',revision=6,enabled=True,pending_disable=c._pending_disable_credentials()))
        self.assertTrue(c.pending_disable_gateway_api_key)
        self.assertFalse(any(e[0]=='enable' for e in c.history))
    def test_unmodified_credential_has_no_shutdown(self):
        c=config();c.write({'gateway_api_key':'OLD-FIXTURE'})
        self.assertFalse(c.pending_disable_gateway_api_key)
    def test_key_change_with_enabled_toggle_has_shutdown(self):
        c=config();c.write({'gateway_api_key':'NEW-FIXTURE','enabled':False})
        self.assertEqual(c.pending_disable_gateway_api_key,'enc:OLD-FIXTURE')
    def test_url_and_key_change_records_old_pair_once(self):
        c=config();c.write({'gateway_url':'https://new.fixture.invalid','gateway_api_key':'NEW-FIXTURE'})
        self.assertEqual(c.pending_disable_gateway_url,'https://gateway.fixture.invalid')
        self.assertEqual(c.pending_disable_gateway_api_key,'enc:OLD-FIXTURE')
    def test_pending_migration_blocks_replacement_without_erasure(self):
        c=config();c.pending_disable_gateway_url='https://older.fixture.invalid';c.pending_disable_gateway_api_key='enc:OLDER-FIXTURE';c.pending_disable_revision=5
        with self.assertRaises(ValidationError):c.write({'gateway_api_key':'NEW-FIXTURE'})
        self.assertEqual(c.pending_disable_gateway_api_key,'enc:OLDER-FIXTURE')
    def test_disabled_and_synced_key_rotation_does_not_need_old_disable(self):
        c=config(enabled=False);c.write({'gateway_api_key':'NEW-FIXTURE'})
        self.assertFalse(c.pending_disable_gateway_api_key)
    def test_cron_replays_old_disable_before_new_enable_after_restart(self):
        c=config();c.write({'gateway_api_key':'NEW-FIXTURE'})
        c.history.clear()  # New worker, no post-commit callback in memory.
        self.assertTrue(c.cron_sync_enabled_state())
        self.assertEqual([x[0] for x in c.history],['disable','enable','complete'])
        self.assertEqual(c.history[0][1]['api_key'],'OLD-FIXTURE')
    def test_cron_does_not_enable_when_replayed_old_disable_fails(self):
        c=config();c.write({'gateway_api_key':'NEW-FIXTURE'})
        c.record_disable=lambda kwargs:c.history.append(('disable_fail',kwargs)) or False
        self.assertTrue(c.cron_sync_enabled_state())  # Cron run completes; key transition remains pending.
        self.assertTrue(c.pending_disable_gateway_api_key)
        self.assertFalse(any(e[0]=='enable' for e in c.history))
    def test_cron_treats_revoked_old_key_as_no_live_activation(self):
        c=config();c.write({'gateway_api_key':'NEW-FIXTURE'})
        c.record_disable=lambda kwargs:(_ for _ in ()).throw(OldUnauthorized('revoked'))
        self.assertTrue(c.cron_sync_enabled_state())
        self.assertTrue(any(e[0]=='enable' for e in c.history))
    def test_already_revoked_key_does_not_block_new_activation(self):
        c=config(revoked=True);c.write({'gateway_api_key':'NEW-FIXTURE'})
        self.assertFalse(c.pending_disable_gateway_api_key)
        self.assertEqual(c.queued[-1]['revision'],6)

if __name__=='__main__':unittest.main(verbosity=2)
