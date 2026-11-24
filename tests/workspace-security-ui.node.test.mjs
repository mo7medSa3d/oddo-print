/** Real component/observer code with deterministic React and network boundaries.
 * Trusted events are explicit boundary fixtures; live browser acceptance is separate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
// No step-up: the WorkspaceSecurity confirmation component was removed with
// the reauth system. What remains here is the expired-only notice, the
// activity observer, and the safe-return-path helper.
const reply = (code, body) => ({ ok: code >= 200 && code < 300, status: code, json: async () => body });

class Target {
  listeners = new Map();
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatchEvent(event) { for (const callback of this.listeners.get(event.type) ?? []) callback(event); return true; }
  size() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.size, 0); }
}

function compile(file, imports, globals = {}) {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const entry = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), source)(imports, entry, entry.exports, ...Object.values(globals));
  return entry.exports;
}

function harness(fetch, options = {}) {
  const states = [], refs = [], effects = [], memos = [], pending = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, memoIndex = 0;
  const document = new Target(); document.visibilityState = "visible";
  const window = new Target();
  window.location = new URL(options.url ?? "https://gateway.test/settings?reauth=1&returnTo=%2Fapi-keys");
  Object.defineProperties(window, {
    localStorage: { get() { assert.fail("credentials must not use localStorage"); } },
    sessionStorage: { get() { assert.fail("credentials must not use sessionStorage"); } },
  });
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(value) { const i = stateIndex++; if (!(i in states)) states[i] = typeof value === "function" ? value() : value; return [states[i], next => { states[i] = typeof next === "function" ? next(states[i]) : next; }]; },
    useRef(value) { const i = refIndex++; return refs[i] ??= { current: value }; },
    useCallback(fn, deps) { const i = memoIndex++; if (!memos[i] || !same(memos[i].deps, deps)) memos[i] = { fn, deps }; return memos[i].fn; },
    useEffect(fn, deps) { const i = effectIndex++; if (!effects[i] || !same(effects[i].deps, deps)) pending.push({ i, fn, deps }); },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  // Controllable stand-in for the real ensureCustomerSession: the heartbeat
  // calls it (not the fetch stub) before every activity post, and again
  // before a retry-once after a 401. It never touches the fetch stub, so
  // fetch-call counts still count activity posts only. `options.ensure`
  // overrides the default authenticated result; `h.ensureCalls` records
  // every invocation in order so tests can assert ensure-first ordering.
  const ensureCalls = [];
  const imports = name => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "next/link") return "Link";
    if (name === "next/navigation") return { useRouter: () => ({ replace() {}, refresh() {} }) };
    if (name.endsWith("/i18n/react")) return { useI18n: () => ({ t: key => key, formatDateTime: value => "formatted:" + value }) };
    if (name.endsWith("/fetch-timeout")) return { fetchWithTimeout: fetch };
    if (name.endsWith("/session-config")) return { ensureCustomerSession: async () => { ensureCalls.push(Date.now()); return options.ensure ? options.ensure() : { authenticated: true, expiresAt: Date.now() + 900_000 }; } };
    if (name.endsWith("/session-sync")) return { subscribeSessionSync: () => () => undefined, broadcastSessionSync: () => undefined };
    if (name === "./ui" || name === "lucide-react") return new Proxy({}, { get: (_target, key) => String(key) });
    throw Error("Unexpected workspace UI dependency " + name);
  };
  const entry = compile("src/components/WorkspaceSecurity.tsx", imports, { window, document, AbortController, Event, URL, URLSearchParams });
  return {
    exports: entry, window, document, states, tree: null, ensureCalls,
    render(name = options.component ?? "WorkspaceSecurityNotice") { stateIndex = refIndex = effectIndex = memoIndex = 0; this.tree = entry[name](); return this.tree; },
    effects() { while (pending.length) { const next = pending.shift(); effects[next.i]?.cleanup?.(); effects[next.i] = { deps: next.deps, fn: next.fn, cleanup: next.fn() }; } },
    replayEffects() { for (const effect of effects) { effect.cleanup?.(); effect.cleanup = effect.fn(); } },
    cleanup() { for (const effect of effects) effect?.cleanup?.(); },
  };
}

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(value => find(value, predicate)).find(Boolean);
  if (!tree || typeof tree !== "object") return undefined;
  return predicate(tree) ? tree : Object.values(tree.props ?? {}).map(value => find(value, predicate)).find(Boolean);
}
async function mount(fetch, options) { const h = harness(fetch, options); h.render(); h.effects(); await flush(); h.render(); return h; }
const treeText = h => JSON.stringify(h.tree);

test("return paths reject external, API, auth, malformed and encoded separator targets", () => {
  const h = harness(async () => reply(200, {})); const safe = h.exports.safeWorkspaceReturnPath;
  assert.equal(safe("/release-readiness", "https://gateway.test"), null);
  for (const path of ["/dashboard#printers", "/api-keys?tab=active", "https://gateway.test/team", "/billing"]) assert.ok(safe(path, "https://gateway.test"));
  for (const path of [null, "", "//external.test", "https://external.test/dashboard", "javascript:alert(1)", "/api/auth/logout", "/login", "/platform/security", "https://user:password@gateway.test/dashboard", "/dashboard%2f..%2fapi/auth/logout", "/dashboard\\evil", "/dashboard\n", " /dashboard", "/dashboard/%ZZ", "/dashboard/../../api/auth/logout"]) assert.equal(safe(path, "https://gateway.test"), null, String(path));
});

test("workspace notice stays silent on mount and shows only an expired sign-in callout", async () => {
  const calls = [];
  const h = await mount(async (url, init) => { calls.push({ url, init }); return reply(204); }, { component: "WorkspaceSecurityNotice", url: "https://gateway.test/team?view=members" });
  assert.equal(calls.length, 0); assert.equal(h.tree, null);
  // An unauthenticated heartbeat (expired session) surfaces the expired
  // callout with a plain sign-in link — never a password prompt.
  const denied = harness(async (url, init) => { calls.push({ url, init }); return reply(204); },
    { component: "WorkspaceSecurityNotice", ensure: () => ({ authenticated: false, expiresAt: 0 }) });
  denied.render(); denied.effects(); await flush();
  denied.document.dispatchEvent({ type: "pointerdown", isTrusted: true }); await flush(); denied.render();
  assert.equal(find(denied.tree, node => node.props?.["data-testid"] === "workspace-session-expired-notice") !== undefined, true);
  assert.match(treeText(denied), /workspaceSecurity\.sessionExpiredTitle/);
  assert.match(treeText(denied), /workspaceSecurity\.signIn/);
  assert.doesNotMatch(treeText(denied), /reauth/);
  denied.cleanup(); h.cleanup();
});

test("activity requires trusted visible input, throttles60s, serializes requests and sends no input data", async () => {
  const calls = [], first = deferred(); let clock = 1000, expired = 0;
  const h = harness(async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? first.promise : reply(204); });
  const stop = h.exports.observeWorkspaceActivity(h.document, () => { expired++; }, () => clock);
  assert.equal(calls.length, 0); assert.deepEqual([...h.document.listeners.keys()].sort(), ["keydown", "pointerdown", "touchstart", "wheel"]);
  h.document.dispatchEvent({ type: "pointerdown", isTrusted: false });
  h.document.visibilityState = "hidden"; h.document.dispatchEvent({ type: "keydown", isTrusted: true });
  h.document.dispatchEvent({ type: "focus", isTrusted: true }); h.document.dispatchEvent({ type: "visibilitychange", isTrusted: true });
  assert.equal(calls.length, 0); h.document.visibilityState = "visible";
  h.document.dispatchEvent({ type: "keydown", isTrusted: true, get key() { assert.fail("never inspect keys"); }, get target() { assert.fail("never inspect form data"); } });
  await flush(); assert.equal(h.ensureCalls.length, 1, "ensure runs before the first activity post"); assert.equal(calls.length, 1); assert.equal(calls[0].url, "/api/auth/activity"); assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.body, undefined);
  clock += 70000; h.document.dispatchEvent({ type: "wheel", isTrusted: true }); await flush(); assert.equal(calls.length, 1, "only one request in flight"); assert.equal(h.ensureCalls.length, 1);
  first.resolve(reply(204)); await flush(); h.document.dispatchEvent({ type: "touchstart", isTrusted: true }); await flush(); assert.equal(calls.length, 2); assert.equal(h.ensureCalls.length, 2, "each activity post is preceded by an ensure");
  clock += 59999; h.document.dispatchEvent({ type: "pointerdown", isTrusted: true }); await flush(); assert.equal(calls.length, 2); assert.equal(h.ensureCalls.length, 2);
  clock++; h.document.dispatchEvent({ type: "pointerdown", isTrusted: true }); await flush(); assert.equal(calls.length, 3); assert.equal(h.ensureCalls.length, 3); assert.equal(expired, 0); stop(); assert.equal(h.document.size(), 0);
});

test("activity401 is definite expiry while network/503 failures never sign out or auto-retry", async () => {
  for (const outcome of [401, 503, "network"]) {
    let count = 0, expired = 0, clock = 0;
    const h = harness(async () => { count++; if (outcome === "network") throw new TypeError("offline"); return reply(outcome); });
    const stop = h.exports.observeWorkspaceActivity(h.document, () => { expired++; }, () => clock);
    h.document.dispatchEvent({ type: "pointerdown", isTrusted: true }); await flush();
    // NEW INTENDED BEHAVIOUR (recoverable heartbeat): ensure first, then the
    // activity post; a 401 post is ensured once more and retried exactly
    // once before expiry is declared, so a 401 costs 2 ensures + 2 posts.
    // Network/503 posts are not retried (1 ensure + 1 post) and never expire.
    assert.equal(expired, outcome === 401 ? 1 : 0);
    assert.equal(count, outcome === 401 ? 2 : 1);
    assert.equal(h.ensureCalls.length, outcome === 401 ? 2 : 1);
    clock = 60000; await flush(); assert.equal(count, outcome === 401 ? 2 : 1, "elapsed time alone never sends activity"); assert.equal(h.ensureCalls.length, outcome === 401 ? 2 : 1);
    h.document.dispatchEvent({ type: "keydown", isTrusted: true }); await flush(); assert.equal(count, outcome === 401 ? 2 : 2); assert.equal(h.ensureCalls.length, outcome === 401 ? 2 : 2); stop();
  }
});

test("activity cleanup aborts the pending request and ignores a late401", async () => {
  const pending = deferred(); let signal, expired = 0;
  const h = harness(async (_url, init) => { signal = init.signal; return pending.promise; });
  const stop = h.exports.observeWorkspaceActivity(h.document, () => { expired++; });
  h.document.dispatchEvent({ type: "pointerdown", isTrusted: true }); await flush(); stop();
  assert.equal(signal.aborted, true); assert.equal(h.document.size(), 0); pending.resolve(reply(401)); await flush(); assert.equal(expired, 0);
});

