import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile('src/server/request-guard.ts', 'utf8');
const start = source.indexOf('const AGENT_ROUTE_BODY_LIMITS:');
const end = source.indexOf('const MUTATING_METHODS =', start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({Math});
const script = new vm.SourceTextModule(
  `const MAX_API_BODY_BYTES = 8388608;\n${stripTypeScriptTypes(source.slice(start, end),{mode:'transform'})}`,
  {context},
);
await script.link(()=>{throw Error('Unexpected import in route limit policy');});
await script.evaluate();
const limit = script.namespace.maxApiBodyBytesForRequest;

test('Agent write routes enforce their published request budgets at the ingress boundary', () => {
  assert.equal(limit('/api/agent/discovery', 'POST'), 2*1024*1024);
  assert.equal(limit('/api/agent/heartbeat', 'POST'), 512*1024);
  assert.equal(limit('/api/agent/register', 'POST'), 64*1024);
  assert.equal(limit('/api/agent/jobs', 'PATCH'), 64*1024);
  assert.equal(limit('/api/agent/discovery?now=true', 'POST'), 2*1024*1024);
  assert.equal(limit('/api/agent/discovery/', 'POST'), 2*1024*1024);
});

test('Limit selection never loosens the global request budget or restricts unrelated routes', () => {
  assert.equal(limit('/api/agent/discovery', 'POST', 1024), 1024);
  assert.equal(limit('/api/agent/discovery', 'GET'), 8*1024*1024);
  assert.equal(limit('/api/print/jobs', 'POST'), 8*1024*1024);
  assert.equal(limit('/api/agent/discovery-extra', 'POST'), 8*1024*1024);
});

test('Real request guard invokes per-route admission selection before forwarding to Next', () => {
  assert.match(source, /const maxBytes = maxApiBodyBytesForRequest\(req\.url, method, options\.maxBytes \?\? MAX_API_BODY_BYTES\)/);
  assert.match(source, /if \(length === null \|\| length > maxBytes\) \{/);
});
