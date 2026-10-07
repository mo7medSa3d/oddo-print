import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/components/PrintCertificationWizard.tsx", "utf8");
const en = fs.readFileSync("src/i18n/messages/en.ts", "utf8");
const ar = fs.readFileSync("src/i18n/messages/ar.ts", "utf8");

test("certification status reconciliation stops after bounded consecutive failures", () => {
  assert.match(source, /const CERT_STATUS_MAX_CONSECUTIVE_FAILURES = 3;/);
  assert.match(source, /const CERT_STATUS_MAX_POLL_MS = 6 \* 60 \* 1000;/);
  assert.match(source, /Date\.now\(\) - startedAt >= CERT_STATUS_MAX_POLL_MS/);
  assert.match(source, /consecutiveFailures \+= 1;/);
  assert.match(source, /consecutiveFailures >= CERT_STATUS_MAX_CONSECUTIVE_FAILURES/);
  assert.match(source, /const pauseReconciliation = \(\) => \{[\s\S]*setReconciliationError\(t\("cert\.reconciliationBody"\)\)/);
  assert.match(source, /consecutiveFailures >= CERT_STATUS_MAX_CONSECUTIVE_FAILURES[\s\S]*pauseReconciliation\(\);[\s\S]*return;/);
});

test("status retry restarts reconciliation without resubmitting a physical print", () => {
  const start = source.indexOf("function retryStatusReconciliation() {");
  const end = source.indexOf("\n  async function runCertification()", start);
  assert.ok(start >= 0 && end > start);
  const retry = source.slice(start, end);
  assert.match(retry, /setPollEpoch\(\(value\) => value \+ 1\)/);
  assert.doesNotMatch(retry, /\/certify|runCertification|fetchWithTimeout/);
  assert.match(source, /\}, \[jobId, pollEpoch, t\]\);/);
});

test("unknown accepted outcome keeps physical rerun disabled and offers explicit status retry copy", () => {
  assert.match(source, /disabled=\{loading \|\| \(!!jobId && !terminal\)\}/);
  assert.match(source, /const liveRunning = !!jobId && !terminal && !reconciliationError;/);
  assert.match(source, /onClick=\{retryStatusReconciliation\}/);
  for (const catalog of [en, ar]) {
    assert.match(catalog, /"cert\.reconciliationTitle"/);
    assert.match(catalog, /"cert\.reconciliationBody"/);
    assert.match(catalog, /"cert\.retryStatus"/);
  }
});
