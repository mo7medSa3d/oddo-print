import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';

// Exercise the real production service and HTTP handler. Only unavailable
// database/Next/Drizzle dependencies are substituted. The credential check
// is a transactional SQL boundary, never a stubbed production function.
const source = (p) => stripTypeScriptTypes(readFileSync(p, 'utf8'), { mode: 'transform' });
const sql = (parts, ...args) => parts.reduce((v, fragment, i) => v + fragment + (i < args.length ? String(args[i]) : ''), '');
const table = (name) => new Proxy({}, { get: (_, key) => `${name}.${String(key)}` });
const noop = () => {};
const fingerprint = (value) => JSON.stringify(value);

async function evaluate(path, deps) {
  const context = createContext({ Buffer, Date, Error, console, Request, Response, URL, process });
  const mod = new SourceTextModule(source(path), { context });
  await mod.link((specifier) => {
    assert.ok(Object.hasOwn(deps, specifier), `missing mock for ${specifier}`);
    const exports = deps[specifier];
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
    }, { context });
  });
  await mod.evaluate();
  return mod.namespace;
}

async function serviceFixture({ keyActive = true, tenantActive = true, printerPresent = true, agentPresent = true, resultFrom = 'receipt', fingerprintValid = true } = {}) {
  const events = [];
  const canonicalize = (value) => value;
  const payload = { type: 'raw', encoding: 'base64', protocol: 'raw', data: 'aGVsbG8=' };
  const tenantId = 'tenant-c';
  const credential = { id: 'key-c', tenantId };
  const printer = { id: 'printer-c', agentId: 'agent-c', tenantId };
  const agent = { id: 'agent-c', tenantId };
  const idempotencyKey = 'receipt-request-c';
  const expectedFingerprint = JSON.stringify({ printerId: printer.id, documentType: 'receipt', destination: null, payload });
  const receipt = { id: 'job-reused', tenantId, printerId: printer.id, agentId: agent.id, apiKeyId: credential.id,
    fingerprint: fingerprintValid ? createHash('sha256').update(expectedFingerprint).digest('hex') : 'mismatched',
    idempotencyKey, status: 'success' };
  const existing = { id: 'job-reused', printer_id: printer.id, agent_id: agent.id,
    api_key_id: credential.id, document_type: 'receipt', destination: null, payload, status: 'success' };
  const tx = {
    query: { printJobReceipts: { findFirst: async () => { events.push('transaction.receipt_lookup'); return resultFrom === 'receipt' ? receipt : null; } } },
    execute: async (query) => {
      events.push(query);
      if (query.includes('clock_timestamp() AS now')) return { rows: [{ now: new Date() }] };
      if (query.includes('FROM api_keys')) return { rows: keyActive ? [{ id: credential.id }] : [] };
      if (query.includes('FROM tenants')) return { rows: [{ lifecycle: tenantActive ? 'active' : 'suspended' }] };
      if (query.includes('FROM print_jobs WHERE tenant_id') && query.includes('idempotency_key')) {
        return { rows: resultFrom === 'active-job' ? [existing] : [] };
      }
      return { rows: [] };
    },
  };
  const db = {
    query: {
      printJobReceipts: { findFirst: async () => { events.push('OUTSIDE_TRANSACTION_RECEIPT_LOOKUP'); return resultFrom === 'receipt' ? receipt : null; } },
      printers: { findFirst: async () => printerPresent ? printer : null }, agents: { findFirst: async () => agentPresent ? agent : null },
    },
    transaction: async (fn) => { events.push('transaction.start'); return fn(tx); },
  };
  const lib = await evaluate('src/lib/print-job-service.ts', {
    'node:crypto': { createHash },
    '../db': { db }, '../db/schema': { agents: table('agents'), printers: table('printers'), printJobs: table('jobs'), printJobReceipts: table('receipts') },
    './printer-virtual': { isVirtualPrinterRecord: () => false, isVirtualCaptureTestRecord: () => false, isApprovedVirtualSpoolerTestRecord: () => false },
    './routing': { isPrinterStatusExecutable: () => true, validatePayloadForPrinter: () => ({ ok: true }) },
    './payload': { validatePrintJobPayload: (value) => value },
    'drizzle-orm': { and: (...x) => x.join(' AND '), eq: (a,b) => `${a}=${b}`, sql },
    './nanoid': { nanoid: () => 'fixed-id-1234' }, './canonicalize': { canonicalize },
    './job-delivery': { MAX_AGENT_IN_FLIGHT_JOBS: 64 },
    './entitlements': { enforceTenantJobEntitlements: async () => { throw Error('not for replay'); }, reserveTenantPrintCredit: async () => { throw Error('not for replay'); } },
    './log': { logInfo: noop, logWarn: noop }, './job-timeline': { recordJobEvent: noop },
    './manager-mutation-authorization': { requireManagerActorInTransaction: noop, ManagerMutationAuthorityChangedError: class extends Error {} },
  });
  const run = () => lib.createPrintJobForPrinter(printer.id, payload, {
    tenantId, requestedBy: 'odoo', rateLimitKeyId: credential.id, idempotencyKey, documentType: 'receipt',
  });
  return { events, run };
}

for (const resultFrom of ['receipt', 'active-job']) {
  test(`idempotency ${resultFrom} must not reuse a job after credential revocation or rotation`, async () => {
    const f = await serviceFixture({ resultFrom, keyActive: false });
    await assert.rejects(f.run(), (error) => error?.code === 'UNAUTHORIZED', 'revoked/rotated credential must fail closed');
    assert.ok(f.events.some((entry) => String(entry).includes('FROM api_keys')), 'read live credential inside transaction');
    assert.ok(f.events.some((entry) => String(entry).includes('FOR UPDATE')), 'credential must be row-locked until commit');
    assert.ok(!f.events.includes('OUTSIDE_TRANSACTION_RECEIPT_LOOKUP'), 'no unfenced shortcut');
    assert.ok(!f.events.includes('transaction.receipt_lookup'), 'do not disclose job identity before permission check');
  });
}

test('active credential may replay identical receipt in the transaction without charging another print', async () => {
  const f = await serviceFixture();
  const job = await f.run();
  assert.equal(job.isReused, true);
  assert.equal(job.id, 'job-reused');
  const lockPosition = f.events.findIndex((entry) => String(entry).includes('FROM api_keys'));
  const lookupPosition = f.events.indexOf('transaction.receipt_lookup');
  assert.ok(lockPosition >= 0 && lookupPosition > lockPosition);
  assert.ok(!f.events.includes('OUTSIDE_TRANSACTION_RECEIPT_LOOKUP'));
});

test('active credential may replay an in-flight job with the same fingerprint', async () => {
  const f = await serviceFixture({ resultFrom: 'active-job' });
  const job = await f.run();
  assert.equal(job.isReused, true);
  assert.equal(job.id, 'job-reused');
  assert.ok(f.events.some((entry) => String(entry).includes('FROM api_keys')));
  assert.ok(!f.events.includes('OUTSIDE_TRANSACTION_RECEIPT_LOOKUP'));
});

for (const absent of ['printer', 'agent']) {
  test(`retained idempotency receipt remains safely replayable after ${absent} metadata is deleted`, async () => {
    const f = await serviceFixture({ printerPresent: absent !== 'printer', agentPresent: absent !== 'agent' });
    const response = await f.run();
    assert.equal(response.id, 'job-reused');
    assert.equal(response.isReused, true);
    const keyLock = f.events.findIndex((v) => String(v).includes('FROM api_keys'));
    const receiptRead = f.events.indexOf('transaction.receipt_lookup');
    assert.ok(receiptRead > keyLock, 'reconciliation must never bypass live authorization');
    assert.ok(!f.events.includes('OUTSIDE_TRANSACTION_RECEIPT_LOOKUP'));
  });
}

test('removed printer cannot bypass revoked Odoo key or reuse a different payload', async () => {
  const revoked = await serviceFixture({ keyActive: false, printerPresent: false });
  await assert.rejects(revoked.run(), (error) => error?.code === 'UNAUTHORIZED');
  const incompatible = await serviceFixture({ printerPresent: false, fingerprintValid: false });
  await assert.rejects(incompatible.run(), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');
});

test('tenant suspension after HTTP authentication rejects a matching receipt even with valid key', async () => {
  const suspended = await serviceFixture({ tenantActive: false });
  await assert.rejects(suspended.run(), (error) => error?.code === 'TENANT_UNAVAILABLE');
  assert.ok(suspended.events.some((v) => String(v).includes('FROM tenants')));
  assert.ok(!suspended.events.includes('transaction.receipt_lookup'));
});

test('active credential cannot reuse the same key for a different payload', async () => {
  const f = await serviceFixture({ fingerprintValid: false });
  await assert.rejects(f.run(), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');
});

async function httpFixture({ reused, revokedAfterAuthentication = false, conflictAfterAuthentication = false } = {}) {
  const calls = [];
  const existing = { id: 'job-old', status: 'success', printerId: 'printer-c', agentId: 'agent-c', destination: null,
    documentType: 'receipt', error: null, apiKeyId: 'key-c' };
  const receipt = { ...existing, fingerprint: 'digest' };
  const db = { query: {
    printJobs: { findFirst: async () => { calls.push('early-job-lookup'); return existing; } },
    printJobReceipts: { findFirst: async () => { calls.push('early-receipt-lookup'); return receipt; } },
  } };
  const PrintJobInputError = class extends Error { constructor(message, code, status) { super(message); this.code = code; this.status = status; } };
  const handler = await evaluate('src/app/api/print/jobs/route.ts', {
    'next/server': { NextResponse: { json: (data, init) => Response.json(data, init) } },
    '../../../../db': { db }, '../../../../db/schema': { printJobs: table('jobs'), printJobReceipts: table('receipts') },
    '../../../../lib/odoo-auth': { validateOdooKey: async () => ({ id: 'key-c', tenantId: 'tenant-c', readOnly: false }) },
    '../../../../lib/payload': { validatePrintJobPayload: (value) => value },
    '../../../../lib/print-job-service': {
      AgentQueueFullError: class extends Error {}, AgentQueuedJobsFullError: class extends Error {}, PrintJobCapabilityError: class extends Error {}, PrintJobInputError,
      idempotencyDigest: () => 'digest', idempotencyFingerprint: fingerprint,
      createPrintJobForPrinter: async () => {
        calls.push('transactional-service');
        if (revokedAfterAuthentication) throw new PrintJobInputError('Credential was revoked', 'UNAUTHORIZED', 401);
        if (conflictAfterAuthentication) throw Object.assign(new Error('Conflicting replay'), { code: 'IDEMPOTENCY_CONFLICT' });
        return { id: 'job-old', printerId: 'printer-c', agentId: 'agent-c', status: 'success', isReused: reused ?? true };
      },
    },
    '../../../../lib/entitlements': { TenantEntitlementError: class extends Error {}, TenantPrintQuotaExceededError: class extends Error {}, isTenantBillingError: () => false },
    '../../../../lib/request-limits': { hasBodyOverLimit: () => false },
    '../../../../lib/log': { logError: noop, requestIdFrom: () => 'req' },
    '../../../../lib/database-clock': { databaseNowMs: () => Date.now() },
    'drizzle-orm': { and: (...v) => v, eq: (a,b) => `${a}=${b}`, isNotNull: (x) => x },
    'zod': { z: { ZodError: class extends Error {}, object: () => ({ strict: () => ({ safeParse: (value) => ({ success: true, data: value }) }) }), string: () => ({ trim() { return this; }, min() {return this;}, max() {return this;}, optional() {return this;} }), unknown: () => ({}) } },
  });
  const req = new Request('https://gateway.test/api/print/jobs', { method: 'POST',
    body: JSON.stringify({ printerId: 'printer-c', documentType: 'receipt', idempotencyKey: 'id-1', payload: { type: 'raw', protocol: 'raw', encoding: 'base64', data: 'aGVsbG8=' } }),
  });
  const response = await handler.POST(req);
  return { response, calls };
}

test('HTTP request must use commit-fenced service even when a matching idempotency job exists', async () => {
  const f = await httpFixture({ revokedAfterAuthentication: true });
  assert.equal(f.response.status, 401);
  assert.ok(f.calls.includes('transactional-service'));
});

test('HTTP request still reports 200 with existing job after validated replay', async () => {
  const f = await httpFixture();
  assert.equal(f.response.status, 200);
  assert.ok(f.calls.includes('transactional-service'));
});

test('HTTP must keep a committed fingerprint conflict as 409, never convert it into an old job success', async () => {
  const f = await httpFixture({ conflictAfterAuthentication: true });
  assert.equal(f.response.status, 409);
  assert.equal((await f.response.json()).code, 'IDEMPOTENCY_CONFLICT');
  assert.ok(f.calls.includes('transactional-service'));
});
