import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildJobDiagnosticPayload } from '../src/lib/job-diagnostic-payload.ts';

test('diagnostic projection never decodes over-limit stored print data', () => {
  const huge = 'A'.repeat(4 * Math.ceil((5 * 1024 * 1024) / 3) + 1);
  const out = buildJobDiagnosticPayload({ type: 'pdf', encoding: 'base64', data: huge });
  assert.deepEqual(out.data, { redacted: true, base64Characters: huge.length, decodedBytes: null, sha256: null });
});

test('diagnostic projection hashes admitted data without disclosing document bytes', () => {
  const data = Buffer.from('receipt test PII');
  const out = buildJobDiagnosticPayload({ type: 'pdf', encoding: 'base64', data: data.toString('base64') });
  assert.equal(out.data.decodedBytes, data.length);
  assert.match(out.data.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(out).includes('receipt test PII'), false);
});
