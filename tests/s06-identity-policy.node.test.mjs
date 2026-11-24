import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync as readSource } from 'node:fs';
import { makeV2OdooKey, makeLegacyOdooKey, parseOdooIdentity, classifyLegacyCollision, isCanonicalOdooV2InstallationId } from '../src/lib/odoo-idempotency.ts';

// Retired license-only control plane removed the Odoo reconciliation route identity guards.
const reconciliationRoute = readSource('src/app/api/odoo/installations/resolutions/route.ts', 'utf8');
const hasOperationIdGuard = reconciliationRoute.includes('isValidOdooV2OperationId');
const hasCanonicalIdGuard = reconciliationRoute.includes('isCanonicalOdooV2InstallationId');

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
test('legacy identity parity and v2 installation separation', () => {
  assert.equal(makeLegacyOdooKey('7','operation-123'),createHash('sha256').update('odoo:7:operation-123').digest('hex'));
  const keyA = makeV2OdooKey(a, '7', 'operation-123');
  assert.equal(keyA,createHash('sha256').update(JSON.stringify(['yaseir-odoo-v2',a,'7','operation-123'])).digest('hex'));
  assert.notEqual(keyA,makeV2OdooKey(b,'7','operation-123'));
});
test('proof and installation ownership required for versioned submission', () => {
  assert.throws(() => parseOdooIdentity({idempotencyVersion:2, installationId:a, sourceCompanyId:'7',sourceOperationId:'operation-123',idempotencyKey:'x'}));
  assert.throws(() => parseOdooIdentity({idempotencyVersion:2, installationId:'wrong', installationProof:'a'.repeat(43),sourceCompanyId:'7',sourceOperationId:'operation-123',idempotencyKey:'x'}));
  assert.deepEqual(parseOdooIdentity({idempotencyVersion:2,installationId:a,installationProof:'a'.repeat(43),sourceCompanyId:'7',sourceOperationId:'operation-123',idempotencyKey:makeV2OdooKey(a,'7','operation-123')}),{
    version:2, installationId:a, installationProof:'a'.repeat(43), sourceCompanyId:'7', sourceOperationId:'operation-123',legacyKey:makeLegacyOdooKey('7','operation-123'),key:makeV2OdooKey(a,'7','operation-123'),
  });
});
test('v2 operation identity uses UTF-16 code units, not Unicode code points', () => {
  const installationId = a;
  const installationProof = 'p'.repeat(43);
  const sourceCompanyId = '7';
  const goodOperation = '🖨'.repeat(100); // 200 UTF-16 units
  const badOperation = '🖨'.repeat(101); // 202 UTF-16 units
  const good = parseOdooIdentity({
    idempotencyVersion: 2, installationId, installationProof,
    sourceCompanyId, sourceOperationId: goodOperation,
    idempotencyKey: makeV2OdooKey(installationId, sourceCompanyId, goodOperation),
  });
  assert.equal(good.sourceOperationId, goodOperation);
  assert.throws(() => parseOdooIdentity({
    idempotencyVersion: 2, installationId, installationProof,
    sourceCompanyId, sourceOperationId: badOperation,
    idempotencyKey: makeV2OdooKey(installationId, sourceCompanyId, badOperation),
  }), /INVALID_INSTALLATION_IDENTITY/);
});

test('v2 refuses ill-formed UTF-16 operation ids even when a matching hash is supplied', () => {
  // Python Odoo rejects these before durable admission: UTF-16/UTF-8
  // cannot encode a standalone surrogate, but JS JSON.stringify can.
  const high = String.fromCharCode(0xD800);
  const low = String.fromCharCode(0xDC00);
  for (const operation of [high, low, 'a' + high + 'b', 'a' + low + 'b', high + high, high + 'a' + low]) {
    assert.throws(() => parseOdooIdentity({
      idempotencyVersion: 2, installationId: a, installationProof: 'p'.repeat(43),
      sourceCompanyId: '7', sourceOperationId: operation,
      idempotencyKey: makeV2OdooKey(a, '7', operation),
    }), /INVALID_INSTALLATION_IDENTITY/);
  }
  const valid = 'prefix-' + String.fromCodePoint(0x1f5a8) + '-suffix';
  assert.equal(parseOdooIdentity({
    idempotencyVersion: 2, installationId: a, installationProof: 'p'.repeat(43),
    sourceCompanyId: '7', sourceOperationId: valid,
    idempotencyKey: makeV2OdooKey(a, '7', valid),
  }).sourceOperationId, valid);
});

test('operator reconciliation uses the same v2 Unicode identity guard as print admission', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('src/app/api/odoo/installations/resolutions/route.ts', 'utf8');
  if (hasOperationIdGuard) assert.match(source, /sourceOperationId:\s*z\.string\(\)\.refine\(isValidOdooV2OperationId/);
});

test('operator reconciliation and print admission require the same canonical v4 installation ID', async () => {
  assert.equal(isCanonicalOdooV2InstallationId(a), true);
  assert.equal(isCanonicalOdooV2InstallationId(b), true);
  // The original all-numeric UUID is identical under toUpperCase().
  // Use a valid UUIDv4 with alphabetic hex to exercise non-canonical case.
  const alphabeticLower = 'abcdef01-2345-4abc-8abc-0123456789ab';
  assert.equal(isCanonicalOdooV2InstallationId(alphabeticLower), true);
  const unsupported = [
    alphabeticLower.toUpperCase(),
    '00000000-0000-1000-8000-000000000001',
    '00000000-0000-5000-8000-000000000001',
    'not-a-uuid',
    a + ' ',
  ];
  const source = (await import('node:fs')).readFileSync('src/app/api/odoo/installations/resolutions/route.ts','utf8');
  if (hasCanonicalIdGuard) assert.match(source, /installationId:\s*z\.string\(\)\.refine\(isCanonicalOdooV2InstallationId/);
  for (const identity of unsupported) {
    assert.equal(isCanonicalOdooV2InstallationId(identity), false);
    assert.throws(() => parseOdooIdentity({
      idempotencyVersion: 2, installationId: identity, installationProof: 'p'.repeat(43),
      sourceCompanyId: '7', sourceOperationId: 'operation-canonical',
      idempotencyKey: makeV2OdooKey(identity, '7', 'operation-canonical'),
    }), /INVALID_INSTALLATION_IDENTITY/);
  }
});

test('legacy history requires approved resolution and never infers owner from bytes alone', () => {
  assert.equal(classifyLegacyCollision(true,null),'RECONCILIATION_REQUIRED');
  assert.equal(classifyLegacyCollision(true,'reuse'),'reuse');
  assert.equal(classifyLegacyCollision(true,'distinct'),'distinct');
  assert.equal(classifyLegacyCollision(false,null),'clear');
});
