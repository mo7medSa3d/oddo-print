import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = fs.readFileSync("src/components/PrintCertificationWizard.tsx", "utf8");
const start = source.indexOf("  async function runCertification() {");
const end = source.indexOf("\n  const completedCount", start);
assert.ok(start >= 0 && end > start);
const handler = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture(send, { previousTerminal = false } = {}) {
  const requests = [];
  const storage = new Map();
  let created = 0;
  let confirmations = 0;
  let steps = null;
  let failure = null;
  const operationKey = { current: previousTerminal ? "previous-operation" : null };
  const noStateUpdateYet = () => {};
  const context = vm.createContext({
    AbortController,
    loading: false,
    jobId: previousTerminal ? "previous-job" : null,
    terminal: previousTerminal,
    inspectBeforeRepeat: previousTerminal,
    printerId: "selected-printer",
    operationKey,
    certificationInFlight: { current: false },
    controllerRef: { current: null },
    window: { confirm: () => { confirmations += 1; return true; } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    crypto: { randomUUID: () => `operation-${++created}` },
    t: key => key,
    setJobId: noStateUpdateYet, setSteps: value => { steps = value; }, setTerminal: noStateUpdateYet,
    setLiveStatus: noStateUpdateYet, setReconciliationError: noStateUpdateYet,
    setLoading: noStateUpdateYet, setError: value => { failure = value; }, setRequestId: noStateUpdateYet,
    setCertified: noStateUpdateYet, setBlocked: noStateUpdateYet, setTimelineUrl: noStateUpdateYet,
    fetchWithTimeout: async (url, init) => {
      requests.push({ url, key: init.headers["Idempotency-Key"] });
      return send();
    },
  });
  vm.runInContext(`${handler}\nglobalThis.run = runCertification;`, context);
  return { run: () => context.run(), requests, operationKey, created: () => created, confirmations: () => confirmations, steps: () => steps, failure: () => failure };
}

const accepted = () => ({ ok: true, json: async () => ({ steps: [], jobId: "accepted-job", requestId: "request", certified: false, blocked: true }) });

for (const previousTerminal of [false, true]) {
  test(`actual certification handler admits one same-tick request; previous terminal=${previousTerminal}`, async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const state = fixture(() => pending, { previousTerminal });
    const first = state.run();
    const second = state.run();
    try {
      assert.equal(state.requests.length, 1, "before React commits loading, only one owner may submit a physical intent");
      assert.equal(state.created(), 1, "a terminal repeat must not mint two idempotency keys");
      assert.equal(state.confirmations(), previousTerminal ? 1 : 0);
      assert.equal(state.requests[0].url, "/api/printers/selected-printer/certify");
    } finally {
      finish(accepted());
      await Promise.all([first, second]);
    }
  });
}

test("actual certification handler releases the flight after response loss and keeps the identical operation key", async () => {
  let calls = 0;
  const state = fixture(async () => {
    if (++calls === 1) throw new Error("response lost after possible enqueue");
    return accepted();
  });
  await state.run();
  await state.run();
  assert.equal(state.requests.length, 2);
  assert.equal(state.created(), 1);
  assert.equal(state.requests[0].key, state.requests[1].key);
  assert.equal(state.operationKey.current, state.requests[0].key);
});

test("a rejected certification keeps returned stage diagnostics and the retry operation identity", async () => {
  const steps = [{ id: "queue", status: "error", message: "Unsupported capability" }];
  const state = fixture(async () => ({ ok: false, json: async () => ({ steps }) }));
  await state.run();
  assert.deepEqual(state.steps(), steps);
  assert.equal(state.failure(), "cert.failedBody");
  await state.run();
  assert.equal(state.requests[0].key, state.requests[1].key);
});

test("a failed acceptance stage overrides physical-unverified warnings in the real summary", () => {
  const start = source.indexOf("  const completedCount");
  const end = source.indexOf("\n  return (", start);
  assert.ok(start >= 0 && end > start);
  const summary = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const tone = vm.runInNewContext(`${summary}\noverallTone`, {
    steps: [{ status: "error" }, { status: "blocked" }], terminal: false, liveStatus: null,
    certified: false, blocked: true, jobId: null, reconciliationError: null,
  });
  assert.equal(tone, "bad");
});
