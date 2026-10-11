import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile('src/lib/email.ts', 'utf8');

async function loadEmailHandler(fetchStub) {
  const context = vm.createContext({ fetch: fetchStub, URL, AbortSignal, Promise, process, setTimeout: (fn) => {fn(); return 0;} });
  const sourceModule = new vm.SourceTextModule(stripTypeScriptTypes(source, {mode: 'transform'}), {context});
  await sourceModule.link((specifier) => {
    if (specifier === 'node:crypto') return new vm.SyntheticModule(['randomUUID'],function(){this.setExport('randomUUID',randomUUID)},{context});
    if (specifier === './runtime-secret') return new vm.SyntheticModule(['runtimeSecret'],function(){this.setExport('runtimeSecret',name => ({RESEND_API_KEY:'fixture',EMAIL_FROM:'print@example.test'})[name])},{context});
    throw new Error(`Unexpected import ${specifier}`);
  });
  await sourceModule.evaluate();
  return sourceModule.namespace.sendTransactionalEmail;
}
const mail = { to: 'operator@example.test', subject: 'Invite', html: '<p>Hi</p>', text: 'Hi' };

test('transient 5xx retry preserves the Resend idempotency key and exact payload', async () => {
  const requests = [];
  const send = await loadEmailHandler(async (url, init) => {
    requests.push({url, init});
    return {ok: requests.length > 1, status: requests.length > 1 ? 200 : 503, text: async () => 'busy'};
  });
  await send(mail);
  assert.equal(requests.length, 2);
  const key = requests[0].init.headers['Idempotency-Key'];
  assert.match(key, /^[0-9a-f-]{36}$/);
  assert.equal(requests[1].init.headers['Idempotency-Key'], key);
  assert.equal(requests[1].init.body, requests[0].init.body);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
});

test('separate email operations receive distinct idempotency keys', async () => {
  const keys=[];
  const send = await loadEmailHandler(async (_url, init) => {
    keys.push(init.headers['Idempotency-Key']);
    return {ok:true, status:200};
  });
  await send(mail);
  await send(mail);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});


test('a timeout after an ambiguous POST is retried with the identical email key', async () => {
  const keys = [];
  const send = await loadEmailHandler(async (_url, init) => {
    keys.push(init.headers['Idempotency-Key']);
    if (keys.length === 1) throw new Error('connection reset while provider processing');
    return {ok:true, status:200};
  });
  await send(mail);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});
