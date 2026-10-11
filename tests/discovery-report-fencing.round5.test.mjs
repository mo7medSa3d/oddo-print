// Round 5 source-executed regression. DB operations and auth are stubbed;
// live PostgreSQL locks and row-level isolation still require integration.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); }
catch { ts = require(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'typescript')); }
const source = 'src/app/api/agent/discovery/route.ts';
const transpiled = ts.transpileModule(readFileSync(source, 'utf8'), {
  fileName: source, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = vm.createContext({ Request, Response, Headers, Buffer, Object, Array, Set, Map, Number, JSON, String, Error });
const moduleOf = (entries) => new vm.SyntheticModule(Object.keys(entries), function () {
  for (const [key, value] of Object.entries(entries)) this.setExport(key, value);
}, { context });
const expr = (strings, ...args) => ({ strings, args });
const exprText = (v) => v?.strings
  ? v.strings.map((part, index) => part + (index < v.args.length ? exprText(v.args[index]) : '')).join('')
  : String(v);
const chain = () => ({ min: chain, max: chain, int: chain, optional: chain, passthrough: chain, safeParse: () => ({ success: true, data: {} }) });
const validator = { object: chain, string: chain, number: chain, enum: chain, unknown: chain, record: chain,
  array: () => ({ max() { return this; }, optional() { return this; }, safeParse: (value) => Array.isArray(value) ? { success: true, data: value } : { success: false } }) };
let state;
function reset() { state = { status: 'running', stats: {}, writes: 0, queries: [], agentActive: true, tenantActive: true }; }
const tx = {
  execute: async (query) => {
    const text = exprText(query); state.queries.push(text);
    if (/FROM agents/i.test(text)) return { rows: state.agentActive ? [{ id: 'agent', lifecycle: 'active' }] : [{ id: 'agent', lifecycle: 'disabled' }] };
    if (/FROM tenants/i.test(text)) return { rows: [{ lifecycle: state.tenantActive ? 'active' : 'suspended' }] };
    if (/FROM discovery_sessions/i.test(text)) return { rows: [{ id: 'disc', status: state.status, stats: state.stats }] };
    throw new Error('Unexpected SQL: ' + text);
  },
  update: () => ({ set: (delta) => ({ where: async () => {
    state.writes++;
    state.status = delta.status || state.status;
    state.stats = delta.stats;
  } }) }),
};
const db = { transaction: async (callback) => callback(tx) };
const schema = { discoverySessions: { id: 'id', agentId: 'agentId', tenantId: 'tenantId' }, discoveredDevices: {} };
const imports = {
  'next/server': moduleOf({ NextResponse: { json: (data, { status = 200 } = {}) => Response.json(data, { status }) } }),
  'node:crypto': moduleOf({ createHash }),
  'drizzle-orm': moduleOf({ sql: expr, eq: (...args) => args, and: (...args) => args, desc: (v) => v }),
  'zod': moduleOf({ z: validator }),
  '../../../../db': moduleOf({ db }),
  '../../../../db/schema': moduleOf(schema),
  '../../../../lib/agent-auth': moduleOf({ validateAgent: async () => ({ id: 'agent', tenantId: 'tenant', lifecycle: 'active' }) }),
  '../../../../lib/nanoid': moduleOf({ nanoid: () => 'random' }),
  '../../../../lib/request-limits': moduleOf({ hasBodyOverLimit: () => false }),
  '../../../../lib/network-address': moduleOf({ isPrivateNetworkAddress: () => true }),
  '../../../../lib/tenant-guard': moduleOf({ requireActiveTenantInTransaction: async (adapter) => {
    const result = await adapter.execute(expr`SELECT lifecycle FROM tenants FOR SHARE`);
    if (result.rows[0].lifecycle !== 'active') throw new Error('TENANT_SUSPENDED');
  } }),
  '../../../../lib/discovery-session-expiry': moduleOf({ expireStaleAgentDiscovery: async () => {} }),
};
const route = new vm.SourceTextModule(transpiled, { context });
await route.link((id) => {
  if (!(id in imports)) throw new Error('Unknown dependency: ' + id);
  return imports[id];
});
await route.evaluate();
const send = (label, {chunkIndex = 0, chunkCount = 1, status = 'completed'} = {}) => route.namespace.POST(new Request('https://gateway.test/api/agent/discovery', {
  method: 'POST', headers: { Authorization: 'Bearer agent:secret', 'Content-Type': 'application/json' },
  body: JSON.stringify({ discoveryId: 'disc', status, chunkIndex, chunkCount,
    totalCandidates: 0, devices: [], errors: [label] }),
}));

test('first report follows Agent -> Tenant -> Session lock order and persists a digest', async () => {
  reset();
  const response = await send('initial');
  assert.equal(response.status, 200);
  assert.equal(state.writes, 1);
  assert.equal(state.status, 'partial'); // source diagnostic changes completed into partial
  assert.equal(state.stats.acceptedChunks[0], 0);
  assert.match(state.stats.chunkDigests[0], /^[0-9a-f]{64}$/);
  assert.match(state.queries[0], /FROM agents[\s\S]+FOR SHARE/);
  assert.match(state.queries[1], /FROM tenants[\s\S]+FOR SHARE/);
  assert.match(state.queries[2], /FROM discovery_sessions[\s\S]+FOR UPDATE/);
});

test('identical terminal replay is acknowledged without a second write', async () => {
  reset(); assert.equal((await send('initial')).status, 200);
  const snapshot = JSON.stringify(state.stats);
  assert.equal((await send('initial')).status, 200);
  assert.equal(state.writes, 1);
  assert.equal(JSON.stringify(state.stats), snapshot);
});

test('changed acknowledged page is rejected without modifying the session', async () => {
  reset(); assert.equal((await send('initial')).status, 200);
  const result = await send('changed-content');
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, 'DISCOVERY_CHUNK_REPLAY_CHANGED');
  assert.equal(state.writes, 1);
});

test('retired or disabled Agent is fenced again inside the transaction', async () => {
  reset(); state.agentActive = false;
  assert.equal((await send('initial')).status, 409);
  assert.equal(state.writes, 0);
});

// The earlier pagination release stored acceptedChunks without a parallel
// chunkDigests array. A partial session may cross the upgrade boundary.
test('legacy session continued at page one preserves digest positions and replay behavior', async () => {
  reset();
  state.stats = {chunkCount: 2, acceptedChunks: [0], inserted: 0, updated: 0, skipped: 0};
  assert.equal((await send('new-terminal', {chunkIndex:1,chunkCount:2})).status, 200);
  assert.equal(state.stats.chunkDigests[0], '');
  assert.match(state.stats.chunkDigests[1], /^[a-f0-9]{64}$/);
  assert.equal((await send('legacy-first', {chunkIndex:0,chunkCount:2,status:'running'})).status, 200);
  assert.equal((await send('new-terminal', {chunkIndex:1,chunkCount:2})).status, 200);
  const mismatched = await send('new-changed', {chunkIndex:1,chunkCount:2});
  assert.equal(mismatched.status, 409);
  assert.equal((await mismatched.json()).code, 'DISCOVERY_CHUNK_REPLAY_CHANGED');
  assert.equal(state.writes, 1);
});
