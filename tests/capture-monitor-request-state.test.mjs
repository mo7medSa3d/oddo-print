import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

// Exercise the production request callback without native WebView dependencies.
const source = readFileSync("src/app/capture-tests/capture-tests-client.tsx", "utf8");
const start = source.indexOf("const load = useCallback(");
const end = source.indexOf("}, [agentFilter]);", start) + "}, [agentFilter]);".length;
assert.ok(start >= 0 && end > start);

function harness() {
  const pending = [];
  const state = { loading: false, paging: false };
  const context = {
    AbortController, Error, Array,
    agentFilter: "all", generation: { current: 0 }, request: { current: null },
    useCallback: fn => fn, paramsFor: () => "/api/test-captures",
    setLoading: value => { state.loading = value; },
    setPaging: value => { state.paging = value; },
    setRows: () => {}, setCursor: () => {}, setSnapshot: () => {}, setError: () => {},
    readError: async () => "INTERNAL_ERROR",
    fetchWithTimeout: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  };
  const load = vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\nload", context);
  const finish = index => pending[index].resolve({ ok: true, json: async () => ({ items: [], agents: [], summary: {}, nextCursor: null }) });
  return { load, pending, finish, state };
}

test("manual refresh after aborting a history page releases both loading states", async () => {
  const { load, pending, finish, state } = harness();
  const older = load(true, { beforeCreatedAt: "2026-10-13", beforeId: "old" });
  assert.equal(state.paging, true);
  const refresh = load(false);
  assert.equal(state.paging, false);
  assert.equal(state.loading, true);
  finish(1);
  await refresh;
  pending[0].reject(new Error("aborted"));
  await older;
  assert.deepEqual(state, { loading: false, paging: false });
});

test("paging after aborting refresh cannot leave the refresh spinner latched", async () => {
  const { load, pending, finish, state } = harness();
  const refresh = load(false);
  const older = load(true, { beforeCreatedAt: "2026-10-13", beforeId: "old" });
  assert.equal(state.loading, false);
  assert.equal(state.paging, true);
  finish(1);
  await older;
  pending[0].reject(new Error("aborted"));
  await refresh;
  assert.deepEqual(state, { loading: false, paging: false });
});
