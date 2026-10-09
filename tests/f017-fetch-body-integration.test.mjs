/** F017/GATEWAY05: real loopback HTTP, actual TypeScript browser fetch helper.
 * The transport, response headers, stream consumption, timeout and cancellation
 * are real Node fetch APIs. This is NOT a browser visual test.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:test';
import http from 'node:http';
import vm from 'node:vm';

async function helper() {
  const source = await readFile(new URL('../src/lib/fetch-timeout.ts', import.meta.url), 'utf8');
  const context = vm.createContext({
    AbortController, AbortSignal, Error, Promise, URL, fetch, setTimeout, clearTimeout,
  });
  const testModule = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), {context});
  await testModule.link(() => { throw new Error('No dependencies expected'); });
  await testModule.evaluate();
  return testModule.namespace.fetchWithTimeout;
}

async function listenBodyServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'content-type': 'application/json', 'x-f017': 'observed'});
    res.flushHeaders();
    res.write('{"ok":');
    setTimeout(() => res.end('true}'), req.url.includes('fast') ? 1 : 280);
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
    const response = await request(`${base}/slow`, {}, 55);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-f017'), 'observed');
    await assert.rejects(response.json());
    assert.ok(performance.now() - started < 245, 'cancellation should beat 280ms body');
  });
});

test('caller signal still cancels stalled JSON body AFTER receiving headers', async () => {
  await withServer(async base => {
    const request = await helper();
    const caller = new AbortController();
    const response = await request(`${base}/slow`, {signal: caller.signal}, 500);
    const started = performance.now();
    setTimeout(() => caller.abort(new Error('navigation cancelled')), 25);
    await assert.rejects(response.json());
    assert.ok(performance.now() - started < 240, 'caller abort should beat 280ms body');
  });
});

test('deadline and caller cancellation propagate into cloned response bodies', async () => {
  await withServer(async base => {
    const request = await helper();
    const response = await request(`${base}/slow`, {}, 55);
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
