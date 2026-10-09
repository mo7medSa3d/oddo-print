import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); }
catch { ts = require(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'typescript')); }
const source = resolve('src/lib/manager-mutation-authorization.ts');
const authSource = resolve('src/lib/authorization.ts');
const compile = (path) => ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { testModule: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: path,
}).outputText;
const events = [];
let state;
const fragment = (strings, ...values) => ({ strings: [...strings], values });
fragment.join = (values, separator) => ({ values, separator });
const valuesOf = (item) => typeof item === 'object' && item && 'values' in item
  ? item.values.flatMap(valuesOf) : [item];
const sqlText = (item) => typeof item === 'object' && item && 'strings' in item
  ? item.strings.map((part, index) => part + (index < item.values.length ? sqlText(item.values[index]) : '')).join('')
  : typeof item === 'object' && item && 'separator' in item
    ? item.values.map(sqlText).join(sqlText(item.separator)) : String(item);
const sqlValues = (item) => typeof item === 'object' && item && 'strings' in item
  ? item.values.flatMap(sqlValues) : typeof item === 'object' && item && 'separator' in item
    ? item.values.flatMap(sqlValues) : [item];
const schemas = { tenantUsers: { userId: 'userId', tenantId: 'tenantId' } };
const context = vm.createContext({ console, Error, Set, Map, String, Object });
const drizzle = new vm.SyntheticModule(['sql', 'and', 'eq'], function() {
  this.setExport('sql', fragment); this.setExport('and', (...args) => args);
  this.setExport('eq', (a,b) => [a,b]);
}, { context });
const schema = new vm.SyntheticModule(['tenantUsers'], function() { this.setExport('tenantUsers', schemas.tenantUsers); }, { context });
const auth = new vm.SourceTextModule(compile(authSource), { context });
await auth.link(() => { throw new Error('Unexpected runtime auth import'); });
await auth.evaluate();
const testModule = new vm.SourceTextModule(compile(source), { context });
await testModule.link((name) => name === 'drizzle-orm' ? drizzle : name.endsWith('db/schema') ? schema : name.endsWith('/authorization') ? auth : (() => { throw new Error('Unexpected '+name); })());
await testModule.evaluate();
const { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } = testModule.namespace;
const tx = {
  query: { tenantUsers: { findFirst: async () => { events.push('membership'); return state.memberRole ? {role:state.memberRole} : null; } } },
  execute: async (query) => {
    const text = sqlText(query), args = sqlValues(query);
    events.push(text);
    if (/users\s+WHERE/.test(text)) return { rows: state.userExists ? [{id:'actor'}] : [] };
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [{}] };
    if (/refresh_tokens/.test(text)) {
      assert.match(text,/family_id\s*=|family_id/); assert.match(text,/tenant_id/);
      assert.match(text,/kind\s*=/); assert.match(text,/role\s*=/);
      assert.match(text,/expires_at > clock_timestamp\(\)/);
      assert.match(text,/revoked_at IS NULL/);
      assert.ok(args.includes(state.claims.familyId));
      assert.ok(args.includes(state.claims.tenantId));
      assert.ok(args.includes(state.claims.role));
      return {rows: state.familyActive ? [{id: 'active'}] : []};
    }
    if (/manager_sessions/.test(text)) {
      assert.match(text,/tenant_id/); assert.match(text,/role/);
      assert.match(text,/FLOOR\(EXTRACT\(EPOCH FROM expires_at\)\)/);
      assert.match(text,/revoked_at IS NULL/);
      assert.ok(args.includes(state.claims.jti));
      return {rows: state.sessionActive ? [{jti:'active'}] : []};
    }
    throw Error('Unexpected query '+text);
  },
};
function setup(patch={}) {
  events.length = 0;
  state = { memberRole:'admin',familyActive:true,sessionActive:true,userExists:true,
    claims:{role:'admin',userId:'actor',tenantId:'tenant',jti:'jti',exp:1781012345,familyId:'family',kind:'manager'},...patch };
  state.claims = {role:'admin',userId:'actor',tenantId:'tenant',jti:'jti',exp:1781012345,familyId:'family',kind:'manager',...patch.claims};
}
const denied = async (permission) => assert.rejects(() => requireManagerActorInTransaction(tx,state.claims,permission),ManagerMutationAuthorityChangedError);

test('same admin family is accepted with user->membership->family ordering', async () => {
  setup(); await requireManagerActorInTransaction(tx,state.claims,'agents.pair');
  assert.match(events[0],/ORDER BY id FOR UPDATE/);
  assert.equal(events[1],'membership');
  assert.match(events[2],/pg_advisory_xact_lock/);
  assert.match(events[3],/refresh_tokens/);
});
test('demoted membership is denied before session read', async () => {setup({memberRole:'viewer'});await denied('agents.pair');assert.equal(events.length,2);});
test('deleted membership denied', async () => {setup({memberRole:null});await denied('agents.pair');});
test('revoked refresh family denied',async()=>{setup({familyActive:false});await denied('agents.pair');});
test('operator cannot start scans even with live session',async()=>{setup({claims:{role:'operator'},memberRole:'operator'});await denied('agents.pair');assert.equal(events.length,0);});
test('non-team userless customer workspace family remains admitted',async()=>{setup({claims:{userId:undefined,kind:'customer'}});await requireManagerActorInTransaction(tx,state.claims,'agents.pair');assert.equal(events[0].includes('pg_advisory_xact_lock'),true);assert.ok(events.at(-1).includes('user_id IS NULL'));});
test('legacy manager session is checked with signed expiry and null-user predicate',async()=>{setup({claims:{familyId:undefined,userId:undefined}});await requireManagerActorInTransaction(tx,state.claims,'agents.pair');assert.match(events[0],/manager_sessions/);assert.match(events[0],/user_id IS NULL/);});
test('revoked legacy session is denied',async()=>{setup({sessionActive:false,claims:{familyId:undefined}});await denied('agents.pair');});
test('related users lock ordered deterministically',async()=>{setup();await requireManagerActorInTransaction(tx,state.claims,'agents.pair',['z','a','a']);assert.match(events[0],/ORDER BY id FOR UPDATE/);const p=sqlValues(fragment`${'a'} ${'actor'} ${'z'}`);assert.ok(p);});
