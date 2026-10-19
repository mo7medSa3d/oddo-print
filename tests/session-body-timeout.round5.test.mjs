import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = await readFile('src/lib/session-config.ts', 'utf8');
async function sourceModule(fetchImpl) {
  // Run the real code with a short fixture deadline, without waiting 10 seconds.
  const shortened = source.replace('const SESSION_FETCH_TIMEOUT_MS = 10_000;', 'const SESSION_FETCH_TIMEOUT_MS = 60;');
  assert.notEqual(shortened, source);
  const context = vm.createContext({ fetch: fetchImpl, AbortSignal, Date, navigator: undefined, Promise });
  const mod = new vm.SourceTextModule(stripTypeScriptTypes(shortened, { mode: 'transform' }), {context});
  await mod.link(() => { throw new Error('Unexpected external dependency'); });
  await mod.evaluate();
  return mod.namespace;
}

test('browser session deadline remains active when headers arrive but JSON never does', async () => {
  let seenSignal;
  const api = await sourceModule(async (_url, {signal}) => {
    seenSignal=signal;
    return {ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once:true });
    })};
  });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(api.ensureCustomerSession(), {name:'TimeoutError'});
    assert.equal(seenSignal.aborted, true);
  } finally { clearTimeout(keepAlive); }
});

test('browser session refresh body also retains its cancellation deadline', async () => {
  let refreshSignal;
  const api = await sourceModule(async (url,{signal}) => {
    if (url === '/api/auth/me') return {ok:false, status:401, json:async()=>({})};
    refreshSignal=signal;
    return {ok:true, status:200, json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
    })};
  });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(api.ensureCustomerSession(), {name:'TimeoutError'});
    assert.equal(refreshSignal.aborted, true);
  } finally { clearTimeout(keepAlive); }
});

test('WebSocket upgrade accounting holds no unused in-process IP-key map', async () => {
  const upgrade = await readFile('src/lib/ws-rate-limit.ts', 'utf8');
  assert.doesNotMatch(upgrade, /localLockedUntil/);
  assert.match(upgrade, /FROM auth_rate_limits/);
  assert.match(upgrade, /FOR UPDATE/);
});
