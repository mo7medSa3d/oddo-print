import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

// Executes the real Agent PATCH handler and real job-status contract. Only
// Next, Drizzle and the unavailable PostgreSQL/Agent boundary are substituted.
// The fake UPDATE evaluates the row-level CASE against the latest stored row
// (including an ACK committed AFTER the route's initial SELECT).
const readTS = (path) => stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'transform' });
const table = (name) => new Proxy({}, { get: (_unused, prop) => `${name}.${String(prop)}` });
const sql = (parts, ...values) => parts.reduce((result, part, i) => result + part + (i < values.length ? String(values[i]) : ''), '');
const noop = () => {};

async function harness({ status = 'claimed', marker = null, delivered = false, acked = false, concurrentAck = false,
  token = 'claim-current', suppliedToken = 'claim-current', claimed = true, ttlMs = -1000 } = {}) {
  const context = createContext({ Buffer, Date, console, Request, Response, URL });
  const changes = [];
  const row = {
    id: 'job-c', tenantId: 'tenant-c', agentId: 'agent-c', printerId: 'printer-c', status,
    error: marker, claimToken: token, claimedAt: claimed ? new Date() : null,
    deliveredAt: delivered ? new Date() : null, ackedAt: acked ? new Date() : null,
    expiresAt: new Date(Date.now() + ttlMs), updatedAt: new Date(),
  };
  const update = () => ({
    set(values) { this.values = values; return this; },
    where(predicate) { this.predicate = predicate; return this; },
    async returning() {
      changes.push({ values: this.values, predicate: this.predicate });
      // A deliberately small PostgreSQL UPDATE model: the row must be expired
      // and owned by the claim, while SET expressions read its latest version.
      if (!this.predicate.includes(`FENCE status=${row.status} token=${row.claimToken}`)) return [];
      if (this.values.status === 'expired' && row.expiresAt > new Date()) return [];
      if (this.values.error?.startsWith?.('CASE')) {
        assert.match(this.values.error, /DELIVERY_EVIDENCE_PENDING/);
        row.error = row.status === 'printing' ? 'JOB_EXPIRED_DURING_PRINT: physical output is unknown'
          : row.deliveredAt || row.ackedAt || row.error === 'DELIVERY_EVIDENCE_PENDING'
            ? 'UNKNOWN_PARTIAL_DELIVERY: job expired with potential delivery'
            : null;
      } else {
        row.error = this.values.error;
      }
      row.status = this.values.status;
      if (this.values.claimToken === 'NULL') row.claimToken = null;
      if (this.values.deliveredAt?.includes?.('COALESCE')) row.deliveredAt ??= new Date();
      return [{ status: row.status, error: row.error }];
    },
  });
  const db = {
    query: {
      printJobs: { findFirst: async () => {
        const snapshot = { ...row };
        if (concurrentAck && row.status === 'claimed' && !row.ackedAt) row.ackedAt = new Date();
        return snapshot;
      } },
      printJobReceipts: { findFirst: async () => null },
    },
    update,
  };
  const mocks = {
    'node:crypto': { createHash },
    '../../../../db': { db },
    '../../../../db/schema': { printJobs: table('jobs'), printJobReceipts: table('receipts') },
    '../../../../lib/agent-auth': { validateAgent: async () => ({ id: 'agent-c', tenantId: 'tenant-c' }) },
    'drizzle-orm': { sql, and: (...parts) => parts.join(' AND '), eq: (a, b) => `${a}=${b}`, isNull: (v) => `${v} IS NULL` },
    'next/server': { NextResponse: { json: (value, init) => Response.json(value, init) } },
    '../../../../lib/log': { logInfo: noop, logWarn: noop, requestIdFrom: () => 'request-c' },
    '../../../../lib/metrics': { incrementMetric: noop },
    '../../../../lib/job-maintenance': { MAX_RETRIES: 5, DELIVERY_EVIDENCE_PENDING: 'DELIVERY_EVIDENCE_PENDING' },
    '../../../../lib/job-delivery': { CLAIM_RETURNING: '', MAX_DELIVERY_ATTEMPTS: 5, MAX_AGENT_IN_FLIGHT_JOBS: 64 },
    '../../../../lib/job-fencing': { fencedJobWrite: (_id, _t, _a, expectedStatus, fence) => `FENCE status=${expectedStatus} token=${fence}`, printingAdmissionLifecycleFence: () => [] },
    '../../../../lib/request-limits': { hasBodyOverLimit: () => false },
    '../../../../lib/agent-availability': { agentStaleThresholdSeconds: () => 90, printerStaleThresholdSeconds: () => 90 },
    '../../../../lib/database-clock': { refreshClockSkew: noop },
    '../../../../lib/entitlements': { liveTenantSubscriptionPredicate: () => 'active' },
    '../../../../lib/job-timeline': { recordJobEvent: async () => {} },
  };
  const timestamp = new SourceTextModule(readTS('src/lib/database-timestamp.ts'), { context });
  await timestamp.link(() => { throw Error('unexpected timestamp import'); });
  const machine = new SourceTextModule(readTS('src/lib/job-status.ts'), { context });
  await machine.link(() => timestamp);
  const route = new SourceTextModule(readTS('src/app/api/agent/jobs/route.ts'), { context });
  await route.link((specifier) => {
    if (specifier.endsWith('/job-status')) return machine;
    const exports = mocks[specifier];
    assert.ok(exports, `unexpected production dependency ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await route.evaluate();
  const patch = async (requestedStatus) => {
    const response = await route.namespace.PATCH(new Request('https://gateway.test/api/agent/jobs', {
      method: 'PATCH', headers: { authorization: 'Bearer isolated-agent', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: row.id, claimToken: suppliedToken, status: requestedStatus }),
    }));
    return { code: response.status, body: await response.json() };
  };
  return { patch, row, changes };
}

test('fenced expiry with pending poll/WS evidence must remain UNKNOWN, never definitely unprinted', async () => {
  const f = await harness({ marker: 'DELIVERY_EVIDENCE_PENDING' });
  const response = await f.patch('expired');
  assert.equal(response.code, 200);
  assert.equal(response.body.physicalOutcome, 'unknown');
  assert.match(f.row.error, /^UNKNOWN_PARTIAL_DELIVERY/);
  assert.equal(f.row.deliveredAt, null, 'an unconfirmed handoff must not fabricate delivered_at');
  assert.equal(f.row.claimToken, 'claim-current', 'late result needs the original token fence');
});

test('ACK committed after the initial SELECT still protects the expiry UPDATE', async () => {
  const f = await harness({ concurrentAck: true });
  const response = await f.patch('expired');
  assert.equal(response.code, 200);
  assert.equal(response.body.physicalOutcome, 'unknown');
  assert.match(f.row.error, /^UNKNOWN_PARTIAL_DELIVERY/);
});

test('claimed job with zero handoff evidence expires as definitely not printed', async () => {
  const f = await harness();
  const response = await f.patch('expired');
  assert.equal(response.code, 200);
  assert.equal(response.body.physicalOutcome, 'not_printed');
  assert.equal(f.row.error, null);
});

test('printing job expires as unknown with the actual execution evidence', async () => {
  const f = await harness({ status: 'printing', delivered: true });
  const response = await f.patch('expired');
  assert.equal(response.code, 200);
  assert.equal(response.body.physicalOutcome, 'unknown');
  assert.match(f.row.error, /^JOB_EXPIRED_DURING_PRINT/);
  assert.ok(f.row.deliveredAt);
});

test('expired unknown handoff can reconcile matching late Agent success without re-dispatch', async () => {
  const f = await harness({ status: 'expired', marker: 'UNKNOWN_PARTIAL_DELIVERY: job expired with potential delivery' });
  const response = await f.patch('success');
  assert.equal(response.code, 200);
  assert.equal(response.body.status, 'success');
  assert.equal(response.body.physicalOutcome, 'unknown', 'agent report does not prove paper output');
  assert.equal(f.changes.length, 1);
  assert.equal(f.row.claimToken, null);
  assert.match(f.row.error, /^LATE_SUCCESS_POST_EXPIRATION/);
});

test('unclaimed expired row cannot be promoted by an arbitrary Agent report', async () => {
  const f = await harness({ status: 'expired', marker: null, claimed: false, token: null, suppliedToken: null });
  const response = await f.patch('success');
  assert.equal(response.code, 409);
  assert.equal(f.changes.length, 0);
});

test('stale claim token cannot expire or reconcile another attempt', async () => {
  const f = await harness({ marker: 'DELIVERY_EVIDENCE_PENDING', suppliedToken: 'stale-token' });
  assert.equal((await f.patch('expired')).code, 409);
  assert.equal(f.row.status, 'claimed', 'database ownership fence rejected the stale write');
  assert.equal(f.changes.length, 1, 'the stale attempt reached but did not pass SQL fencing');
  const expired = await harness({ status: 'expired', marker: 'UNKNOWN_PARTIAL_DELIVERY: handoff', suppliedToken: 'stale-token' });
  assert.equal((await expired.patch('success')).code, 409);
  assert.equal(expired.changes.length, 0);
});

test('database expiry fence rejects early Agent expiry', async () => {
  const f = await harness({ marker: 'DELIVERY_EVIDENCE_PENDING', ttlMs: 60000 });
  assert.equal((await f.patch('expired')).code, 409);
  assert.equal(f.row.status, 'claimed');
});

test('late result after a poll/WS handoff without ACK reconciles the same fenced failed attempt', async () => {
  // The sweeper stores this exact marker after a lost HTTP response or a WS
  // send with no durable delivered_at/acked_at. Keeping the claim token must
  // make a late Agent success report useful rather than permanently rejected.
  const f = await harness({ status: 'failed', marker: 'UNKNOWN_PARTIAL_DELIVERY: claim lease expired after delivery without an execution report' });
  const result = await f.patch('success');
  assert.equal(result.code, 200);
  assert.equal(result.body.status, 'success');
  assert.equal(result.body.physicalOutcome, 'unknown');
  assert.equal(f.row.claimToken, null);
  assert.match(f.row.error, /^LATE_SUCCESS:/);
});

test('late failed handoff must reject a different attempt token and unclaimed rows', async () => {
  const bad = await harness({ status: 'failed', marker: 'UNKNOWN_PARTIAL_DELIVERY: no response', suppliedToken: 'claim-other' });
  assert.equal((await bad.patch('success')).code, 409);
  const unclaimed = await harness({ status: 'failed', marker: 'UNKNOWN_PARTIAL_DELIVERY: no response', claimed: false });
  assert.equal((await unclaimed.patch('success')).code, 409);
});
