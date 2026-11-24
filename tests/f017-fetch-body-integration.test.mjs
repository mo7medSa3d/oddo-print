/** F017/GATEWAY05: real loopback HTTP, actual TypeScript browser fetch helper.
 * The transport, response headers, stream consumption, timeout and cancellation
 * are real Node fetch APIs. This is NOT a browser visual test.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import http from 'node:http';
import vm from 'node:vm';

// The contract is cancellation after real headers, not a 55ms localhost SLO.
// Cold fetch startup on a busy CI host can take longer than that before a
// connection is established. Keep a wide gap between deadline and body end,
// and retain the assertion that cancellation wins before a complete body.
const BODY_DEADLINE_MS = 2_000;
const SLOW_BODY_MS = 5_000;

async function helper() {
  const source = await readFile(new URL('../src/lib/fetch-timeout.ts', import.meta.url), 'utf8');
  const context = vm.createContext({
    AbortController, AbortSignal, Error, Promise, Request, URL, fetch, setTimeout, clearTimeout,
  });
  const testModule = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), {context});
  // fetch-timeout's ONLY import is session-config's ensureCustomerSession,
  // used solely by fetchWithSessionRetry (never by fetchWithTimeout under
  // test here). Link it to a throwing stand-in so any accidental refresh
  // from the body path fails the test instead of silently passing.
  await testModule.link(specifier => {
    if (specifier !== './session-config') throw new Error('No dependencies expected: ' + specifier);
    return new vm.SourceTextModule(
      'export function ensureCustomerSession() { throw new Error("fetchWithTimeout must not refresh"); }',
      {context},
    );
  });
  await testModule.evaluate();
  return testModule.namespace.fetchWithTimeout;
}

async function listenBodyServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'content-type': 'application/json', 'x-f017': 'observed'});
    res.flushHeaders();
    res.write('{"ok":');
    const timer = setTimeout(() => res.end('true}'), req.url.includes('fast') ? 1 : SLOW_BODY_MS);
    res.once('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {server, base: `http://127.0.0.1:${server.address().port}`};
}

async function withServer(fn) {
  const {server, base} = await listenBodyServer();
  try { await fn(base); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('deadline still cancels a stalled JSON body AFTER receiving HTTP headers', async () => {
  await withServer(async base => {
    const request = await helper();
    const started = performance.now();
    const response = await request(`${base}/slow`, {}, BODY_DEADLINE_MS);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-f017'), 'observed');
    await assert.rejects(response.json());
    assert.ok(performance.now() - started < SLOW_BODY_MS - 500, 'deadline must cancel before the complete body');
  });
});

test('caller signal still cancels stalled JSON body AFTER receiving headers', async () => {
  await withServer(async base => {
    const request = await helper();
    const caller = new AbortController();
    const response = await request(`${base}/slow`, {signal: caller.signal}, SLOW_BODY_MS + 1_000);
    const started = performance.now();
    setTimeout(() => caller.abort(new Error('navigation cancelled')), 25);
    await assert.rejects(response.json());
    assert.ok(performance.now() - started < SLOW_BODY_MS - 500, 'caller abort must beat both the body and deadline');
  });
});

test('deadline and caller cancellation propagate into cloned response bodies', async () => {
  await withServer(async base => {
    const request = await helper();
    const response = await request(`${base}/slow`, {}, BODY_DEADLINE_MS);
    const clone = response.clone();
    const result = await Promise.allSettled([response.json(), clone.json()]);
    assert.equal(result[0].status, 'rejected');
    assert.equal(result[1].status, 'rejected');
  });
});

test('an on-time body is readable without altering the native Response contract', async () => {
  await withServer(async base => {
    const request = await helper();
    const response = await request(`${base}/fast`, {}, 500);
    assert.equal(response.url, `${base}/fast`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-f017'), 'observed');
    assert.deepEqual(await response.json(), {ok:true});
  });
});

test('a Request-owned cancellation still aborts the body after response headers', async () => {
  await withServer(async base => {
    const request = await helper();
    const caller = new AbortController();
    const input = new Request(`${base}/slow`, {signal: caller.signal});
    const response = await request(input, {}, 1_000);
    caller.abort(new Error('request navigation cancelled'));
    await assert.rejects(response.json());
  });
});

test('an already cancelled Request is not sent and retains the caller reason', async () => {
  await withServer(async base => {
    const request = await helper();
    const caller = new AbortController();
    caller.abort(new Error('request was cancelled'));
    const input = new Request(`${base}/fast`, {signal: caller.signal});
    await assert.rejects(request(input, {}, 1_000), /request was cancelled/);
  });
});

test('an explicit init signal overrides the signal inherited from a Request', async () => {
  await withServer(async base => {
    const request = await helper();
    const inherited = new AbortController();
    inherited.abort(new Error('superseded caller'));
    const replacement = new AbortController();
    const input = new Request(`${base}/fast`, {signal: inherited.signal});
    const response = await request(input, {signal: replacement.signal}, 1_000);
    assert.deepEqual(await response.json(), {ok:true});
  });
});
