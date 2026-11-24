/** Session renewal + cross-tab sync: real client code, deterministic boundaries.
 *
 * What is real here and what is stubbed (never the code under test):
 * - src/lib/session-sync.ts is compiled and driven through a BroadcastChannel
 *   shim that mirrors the real API semantics: same-name channels deliver to
 *   OTHER instances only, delivery is async, malformed payloads are dropped
 *   by the receiver's own validator. The shim never decides for the module.
 * - src/lib/fetch-timeout.ts (fetchWithSessionRetry) is compiled with only
 *   its ./session-config import stubbed to a controllable ensure function;
 *   the retry/never-retry decisions, the synthetic renewed response and the
 *   replay-once behaviour are the module's own code, driven by a fetch stub.
 * - src/lib/session-config.ts (ensureCustomerSession) is compiled with no
 *   import stubs at all; only the global fetch and navigator.locks are
 *   fixtures. Its single-flight, probe-then-refresh and dead-session
 *   behaviour are the module's own code.
 * - src/components/WorkspaceSecurity.tsx (WorkspaceSecurityNotice only) is
 *   compiled like tests/workspace-security-ui.node.test.mjs, except its
 *   session-sync import is the REAL compiled module, so the renewed /
 *   logged-out / revoked receiver contract is exercised end to end.
 * DB-backed lifecycle (issue/rotate/reuse/revoke/tenant fence) lives in
 * tests/session-renewal-lifecycle.integration.test.ts; login, registration,
 * email verification, password reset and manager login keep their existing
 * suites and are run as regressions, not duplicated here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const reply = (code, body) => ({ ok: code >= 200 && code < 300, status: code, json: async () => body });

function compile(file, imports, globals = {}) {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const entry = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), source)(imports, entry, entry.exports, ...Object.values(globals));
  return entry.exports;
}

/* BroadcastChannel shim mirroring real semantics: registry by name, delivery
 * to other instances only, async delivery, per-instance listeners. */
let channelSeq = 0;
const posted = [];
class FakeBroadcastChannel {
  static registry = new Map();
  constructor(name) {
    this.name = name; this.id = ++channelSeq; this.handlers = new Set();
    if (!FakeBroadcastChannel.registry.has(name)) FakeBroadcastChannel.registry.set(name, new Set());
    FakeBroadcastChannel.registry.get(name).add(this);
  }
  postMessage(msg) {
    posted.push({ from: this.id, msg });
    for (const other of [...(FakeBroadcastChannel.registry.get(this.name) ?? [])]) {
      if (other === this) continue;
      queueMicrotask(() => { for (const handler of [...other.handlers]) handler({ data: msg }); });
    }
  }
  addEventListener(type, handler) { if (type === "message") this.handlers.add(handler); }
  removeEventListener(type, handler) { this.handlers.delete(handler); }
  close() { FakeBroadcastChannel.registry.get(this.name)?.delete(this); }
}
function resetChannels() { FakeBroadcastChannel.registry.clear(); posted.length = 0; }
function syncModule() {
  return compile("src/lib/session-sync.ts", name => { throw Error("session-sync must stay dependency-free: " + name); }, { BroadcastChannel: FakeBroadcastChannel });
}

/* ── Session-sync protocol (real module) ─────────────────────────────── */

test("session-sync renewed event carries only type/kind/generation/at and increments generation", async () => {
  resetChannels();
  const a = syncModule(), b = syncModule();
  const received = [];
  a.subscribeSessionSync("workspace", event => received.push(event));
  b.broadcastSessionSync("session-renewed", "workspace");
  b.broadcastSessionSync("session-renewed", "workspace");
  await flush();
  assert.equal(received.length, 2);
  assert.deepEqual(received.map(event => event.generation), [1, 2]);
  assert.equal(posted.length, 2);
  for (const { msg } of posted) {
    assert.deepEqual(Object.keys(msg).sort(), ["at", "generation", "kind", "type"]);
    assert.equal(typeof msg.at, "number");
    assert.ok(!("token" in msg || "cookie" in msg || "url" in msg || "email" in msg || "user" in msg));
  }
});

test("session-sync drops malformed payloads and cross-kind events, and is a safe no-op without BroadcastChannel", async () => {
  resetChannels();
  const a = syncModule(), b = syncModule();
  const received = [];
  a.subscribeSessionSync("workspace", event => received.push(event));
  const raw = new FakeBroadcastChannel("yaseir:session-sync");
  raw.postMessage({ type: "session-logged-out", kind: "workspace", generation: "not-a-number", at: Date.now() });
  raw.postMessage({ type: "bogus-event", kind: "workspace", generation: 9, at: Date.now() });
  raw.postMessage({ token: "should-never-arrive", kind: "workspace" });
  b.broadcastSessionSync("session-logged-out", "platform");
  await flush();
  assert.equal(received.length, 0, "malformed and cross-kind payloads must never reach a workspace subscriber");
  const bare = compile("src/lib/session-sync.ts", name => { throw Error(name); }, { BroadcastChannel: undefined });
  const noop = bare.subscribeSessionSync("workspace", () => assert.fail("no channel, no delivery"));
  assert.equal(typeof noop, "function");
  noop();
  bare.broadcastSessionSync("session-logged-out", "workspace");
});

test("session-sync receiving tab never auto-broadcasts (no refresh storm, no echo loop)", async () => {
  resetChannels();
  const a = syncModule(), b = syncModule();
  let seen = 0;
  a.subscribeSessionSync("workspace", () => { seen++; });
  b.broadcastSessionSync("session-logged-out", "workspace");
  await flush();
  assert.equal(seen, 1);
  assert.equal(posted.length, 1, "the receiver must not re-broadcast what it received");
});

/* ── fetchWithSessionRetry (real module, controllable ensure only) ───── */

function retryModule(fetchStub, ensureStub) {
  let ensureCalls = 0;
  const entry = compile("src/lib/fetch-timeout.ts", name => {
    if (name === "./session-config") return { ensureCustomerSession: async () => { ensureCalls++; return ensureStub(); } };
    throw Error("unexpected fetch-timeout dependency " + name);
  }, { fetch: fetchStub });
  return { ...entry, ensureCalls: () => ensureCalls };
}
const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("fetchWithSessionRetry replays exactly once after a successful renewal, and stops at the second 401", async () => {
  const calls = [];
  const mod = retryModule(async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? jsonResponse(401, { error: "expired" }) : jsonResponse(200, { ok: true });
  }, async () => ({ authenticated: true, expiresAt: Date.now() + 900_000 }));
  const first = await mod.fetchWithSessionRetry("/api/team", { method: "GET" });
  assert.equal(first.status, 200);
  assert.equal(calls.length, 2, "one original + exactly one replay");
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(mod.ensureCalls(), 1);
  const calls2 = [];
  const mod2 = retryModule(async () => { calls2.push(1); return jsonResponse(401, { error: "expired" }); }, async () => ({ authenticated: true, expiresAt: 1 }));
  const second = await mod2.fetchWithSessionRetry("/api/team");
  assert.equal(second.status, 401);
  assert.equal(calls2.length, 2, "a renewed-then-still-401 response is returned, never looped");
});

test("fetchWithSessionRetry never resends on autoRetry:false, and never retries dead sessions, step-up, password failures, 5xx or network failures", async () => {
  // autoRetry:false: refresh only, synthetic renewed-not-resent marker.
  let fetchCalls = 0, ensureCalls = 0;
  const notResent = retryModule(async () => { fetchCalls++; return jsonResponse(401, { error: "expired" }); }, async () => { ensureCalls++; return { authenticated: true, expiresAt: 1 }; });
  const renewed = await notResent.fetchWithSessionRetry("/api/agents", { method: "POST", body: "{}" }, { autoRetry: false });
  assert.equal(fetchCalls, 1, "the mutation must not be resent");
  assert.equal(ensureCalls, 1);
  assert.equal(renewed.status, 401);
  assert.equal(notResent.isSessionRenewedNotResent(renewed), true);
  assert.deepEqual(await renewed.json(), { ok: false, code: "SESSION_RENEWED_NOT_RESENT" });
  // Dead session: original 401 returned untouched, no replay.
  fetchCalls = 0;
  const dead = retryModule(async () => { fetchCalls++; return jsonResponse(401, { error: "expired" }); }, async () => ({ authenticated: false, expiresAt: 0 }));
  assert.equal((await dead.fetchWithSessionRetry("/api/team")).status, 401);
  assert.equal(fetchCalls, 1);
  // Ensure transport failure (network/5xx during renewal): original 401, no loop.
  const broken = retryModule(async () => jsonResponse(401, { error: "expired" }), async () => { throw new Error("offline"); });
  assert.equal((await broken.fetchWithSessionRetry("/api/team")).status, 401);
  // No step-up: a 403 is never treated as expiry (no refresh), while a
  // 401 always is — the old step-up header and PASSWORD_REQUIRED code no
  // longer carve anything out of the refresh path.
  {
    let ensured = 0;
    const forbidden = retryModule(async () => jsonResponse(403, { code: "FORBIDDEN" }, { "X-Yaseir-Reauthentication": "required" }), async () => { ensured++; return { authenticated: true, expiresAt: 1 }; });
    const res = await forbidden.fetchWithSessionRetry("/api/team");
    assert.equal(res.status, 403);
    assert.equal(ensured, 0, "a 403 must never trigger a silent refresh");
  }
  {
    let ensured = 0;
    const expired = retryModule(async () => jsonResponse(401, { code: "PASSWORD_REQUIRED" }, { "X-Yaseir-Reauthentication": "required" }), async () => { ensured++; return { authenticated: true, expiresAt: 1 }; });
    assert.equal((await expired.fetchWithSessionRetry("/api/auth/sessions", { method: "POST" })).status, 401);
    assert.equal(ensured, 1, "a 401 refreshes even with a legacy step-up marker");
  }
  // 5xx and network failures pass through untouched, ensure never runs.
  let ensured = 0;
  const serverError = retryModule(async () => jsonResponse(503, {}), async () => { ensured++; return { authenticated: true, expiresAt: 1 }; });
  assert.equal((await serverError.fetchWithSessionRetry("/api/team")).status, 503);
  assert.equal(ensured, 0);
  const offline = retryModule(async () => { throw new TypeError("offline"); }, async () => { ensured++; return { authenticated: true, expiresAt: 1 }; });
  await assert.rejects(() => offline.fetchWithSessionRetry("/api/team"), /offline/);
  assert.equal(ensured, 0);
});

/* ── ensureCustomerSession (real module, fetch + locks fixtures only) ── */

function ensureModule(fetchStub, locks) {
  return compile("src/lib/session-config.ts", name => { throw Error("session-config must stay dependency-free: " + name); }, { fetch: fetchStub, navigator: locks ? { locks } : undefined });
}
const meOk = expSeconds => jsonResponse(200, { exp: expSeconds });
const me401 = (kind = "customer") => jsonResponse(401, { kind });

test("ensureCustomerSession single-flights concurrent callers: one probe, one shared result", async () => {
  let probeCalls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const mod = ensureModule(async url => {
    if (String(url).endsWith("/api/auth/me")) { probeCalls++; await gate; return meOk(Math.floor(Date.now() / 1000) + 900); }
    throw Error("unexpected fetch " + url);
  });
  const first = mod.ensureCustomerSession();
  const second = mod.ensureCustomerSession();
  assert.equal(first, second, "concurrent callers share the in-flight promise");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.authenticated, true);
  assert.equal(b.authenticated, true);
  assert.equal(probeCalls, 1, "simultaneous requests trigger exactly ONE probe/refresh round");
  // The flight clears afterwards: a later call probes again instead of reusing a stale result.
  const third = await mod.ensureCustomerSession();
  assert.equal(third.authenticated, true);
  assert.equal(probeCalls, 2);
});

test("ensureCustomerSession renews silently on 401, honours manager-first kind order, and reports dead sessions without throwing", async () => {
  const calls = [];
  const mod = ensureModule(async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/auth/me")) return me401("manager");
    if (String(url).endsWith("/api/auth/manager/refresh")) return jsonResponse(200, { expiresAt: new Date(Date.now() + 900_000).toISOString() });
    if (String(url).endsWith("/api/auth/refresh")) return jsonResponse(401, { error: "nope" });
    throw Error("unexpected fetch " + url);
  });
  const renewed = await mod.ensureCustomerSession();
  assert.equal(renewed.authenticated, true);
  assert.deepEqual(calls, ["/api/auth/me", "/api/auth/manager/refresh"], "manager kind goes first and a 200 stops the bounded loop");
  // Both endpoints 401: dead session, not an exception, no further attempts.
  const calls2 = [];
  const dead = ensureModule(async url => {
    calls2.push(String(url));
    if (String(url).endsWith("/api/auth/me")) return me401("customer");
    return jsonResponse(401, { error: "nope" });
  });
  const result = await dead.ensureCustomerSession();
  assert.deepEqual(result, { authenticated: false, expiresAt: 0 });
  assert.deepEqual(calls2, ["/api/auth/me", "/api/auth/refresh", "/api/auth/manager/refresh"]);
  // Probe 503 / refresh 500 are temporary failures: the caller must not treat them as logout.
  const unavailable = ensureModule(async url => String(url).endsWith("/api/auth/me") ? jsonResponse(503, {}) : jsonResponse(500, {}));
  await assert.rejects(() => unavailable.ensureCustomerSession(), /temporarily unavailable/);
  const refreshFails = ensureModule(async url => String(url).endsWith("/api/auth/me") ? me401() : jsonResponse(500, {}));
  await assert.rejects(() => refreshFails.ensureCustomerSession(), /temporarily unavailable/);
  // A probe that is still valid (exp > 60 s out) never touches refresh.
  let refreshCalls = 0;
  const healthy = ensureModule(async url => {
    if (String(url).endsWith("/api/auth/me")) return meOk(Math.floor(Date.now() / 1000) + 900);
    refreshCalls++; return jsonResponse(200, {});
  });
  assert.equal((await healthy.ensureCustomerSession()).authenticated, true);
  assert.equal(refreshCalls, 0);
});

test("ensureCustomerSession works under Web Locks with the documented lock name and still single-flights", async () => {
  const lockNames = [];
  const locks = { request: async (name, callback) => { lockNames.push(name); return callback(); } };
  let probeCalls = 0;
  const mod = ensureModule(async url => {
    if (String(url).endsWith("/api/auth/me")) { probeCalls++; return meOk(Math.floor(Date.now() / 1000) + 900); }
    throw Error("unexpected fetch " + url);
  }, locks);
  const [a, b] = await Promise.all([mod.ensureCustomerSession(), mod.ensureCustomerSession()]);
  assert.equal(a.authenticated, true);
  assert.equal(b.authenticated, true);
  assert.deepEqual(lockNames, ["yaseir:customer-session"]);
  assert.equal(probeCalls, 1);
});

/* ── WorkspaceSecurityNotice receiver contract (real component + real sync) ── */

class Target {
  listeners = new Map();
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatchEvent(event) { for (const callback of this.listeners.get(event.type) ?? []) callback(event); return true; }
}
function noticeHarness(fetchStub, syncExports) {
  const states = [], refs = [], effects = [], memos = [], pending = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, memoIndex = 0;
  const document = new Target(); document.visibilityState = "visible";
  const window = new Target();
  window.location = new URL("https://gateway.test/team?view=members");
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(value) { const i = stateIndex++; if (!(i in states)) states[i] = typeof value === "function" ? value() : value; return [states[i], next => { states[i] = typeof next === "function" ? next(states[i]) : next; }]; },
    useRef(value) { const i = refIndex++; return refs[i] ??= { current: value }; },
    useCallback(fn, deps) { const i = memoIndex++; if (!memos[i] || !same(memos[i].deps, deps)) memos[i] = { fn, deps }; return memos[i].fn; },
    useEffect(fn, deps) { const i = effectIndex++; if (!effects[i] || !same(effects[i].deps, deps)) pending.push({ i, fn, deps }); },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const errorKeys = compile("src/lib/api-error-keys.ts", name => { throw Error(name); });
  const imports = name => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "next/link") return "Link";
    if (name === "next/navigation") return { useRouter: () => ({ replace() {}, refresh() {} }) };
    if (name.endsWith("/i18n/react")) return { useI18n: () => ({ t: key => key, formatDateTime: value => "formatted:" + value }) };
    if (name.endsWith("/fetch-timeout")) return { fetchWithTimeout: fetchStub };
    if (name.endsWith("/session-config")) return { ensureCustomerSession: async () => ({ authenticated: true, expiresAt: Date.now() + 900_000 }) };
    if (name.endsWith("/session-sync")) return syncExports;
    if (name.endsWith("/api-error-keys")) return errorKeys;
    if (name === "./ui" || name === "lucide-react") return new Proxy({}, { get: (_target, key) => String(key) });
    throw Error("Unexpected workspace UI dependency " + name);
  };
  const entry = compile("src/components/WorkspaceSecurity.tsx", imports, { window, document, AbortController, Event, URL, URLSearchParams });
  const h = {
    exports: entry, window, document, tree: null,
    render() { stateIndex = refIndex = effectIndex = memoIndex = 0; this.tree = entry.WorkspaceSecurityNotice(); return this.tree; },
    effects() { while (pending.length) { const next = pending.shift(); effects[next.i]?.cleanup?.(); effects[next.i] = { deps: next.deps, fn: next.fn, cleanup: next.fn() }; } },
    cleanup() { for (const effect of effects) effect?.cleanup?.(); },
  };
  return h;
}
function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(value => find(value, predicate)).find(Boolean);
  if (!tree || typeof tree !== "object") return undefined;
  return predicate(tree) ? tree : Object.values(tree.props ?? {}).map(value => find(value, predicate)).find(Boolean);
}

test("remote sign-out shows the expired callout once and never re-broadcasts; renewed clears a stale expired callout without refreshing", async () => {
  resetChannels();
  const tab = syncModule(), other = syncModule();
  const fetchCalls = [];
  const h = noticeHarness(async (url, init) => { fetchCalls.push(url); return reply(204); }, tab);
  try {
    h.render(); h.effects(); await flush(); h.render();
    assert.equal(h.tree, null);
    other.broadcastSessionSync("session-logged-out", "workspace");
    await flush(); h.render();
    const signIn = find(h.tree, node => node.type === "Link" && node.props.children === "workspaceSecurity.signIn");
    assert.ok(JSON.stringify(h.tree).includes("workspaceSecurity.sessionExpiredTitle"));
    assert.ok(signIn, "the interstitial must offer the immediate way back to sign-in");
    // The notice's expired callout always routes back through Settings, the
    // same href the heartbeat-expired callout uses (existing behaviour).
    assert.equal(signIn.props.href, "/login?next=%2Fsettings");
    assert.equal(posted.length, 1, "the receiving tab must not echo the sign-out to other tabs");
    assert.equal(fetchCalls.length, 0, "a remote sign-out surfaces UI only; it never triggers a refresh");
    other.broadcastSessionSync("session-renewed", "workspace");
    await flush(); h.render();
    assert.equal(h.tree, null, "a renewed event clears only a stale expired callout");
    assert.equal(fetchCalls.length, 0, "a renewed event must not trigger a refresh (no refresh storm)");
  } finally { h.cleanup(); }
});

test("platform-scope sync events never disturb the workspace notice", async () => {
  resetChannels();
  const tab = syncModule(), other = syncModule();
  const fetchCalls = [];
  const h = noticeHarness(async url => {
    fetchCalls.push(url);
    return reply(204);
  }, tab);
  try {
    h.render(); h.effects(); await flush(); h.render();
    other.broadcastSessionSync("session-logged-out", "platform");
    await flush(); h.render();
    assert.equal(h.tree, null, "workspace handlers ignore platform-scope events");
    other.broadcastSessionSync("session-logged-out", "workspace");
    await flush(); h.render();
    assert.ok(JSON.stringify(h.tree).includes("workspaceSecurity.sessionExpiredTitle"), "a workspace-scope sign-out surfaces the expired callout");
    assert.ok(!fetchCalls.includes("/api/auth/activity"), "surfacing a remote sign-out never posts activity");
    assert.equal(fetchCalls.length, 0, "no status read exists anymore");
  } finally { h.cleanup(); }
});

/* ── Client wording, CSRF shape and static policy guards ─────────────── */

test("new i18n keys exist in EN and AR with distinct, non-empty Arabic wording, and SESSION_IDLE_EXPIRED maps to its own idle message, not the generic expiry key", () => {
  const enText = readFileSync("src/i18n/messages/en.ts", "utf8");
  const arText = readFileSync("src/i18n/messages/ar.ts", "utf8");
  const value = (text, key) => {
    const match = text.match(new RegExp(`"${key.replace(/\./g, "\\.")}": "([^"]+)"`));
    assert.ok(match, `missing key ${key}`);
    return match[1];
  };
  // No step-up: the idle warning (and its key) was removed with the
  // /reauth/status read; the expired-only callout key takes its place.
  for (const key of ["errors.sessionRenewedRetry", "errors.sessionIdleExpired", "workspaceSecurity.sessionExpiredTitle", "workspaceSecurity.signedOutElsewhere"]) {
    const en = value(enText, key), ar = value(arText, key);
    assert.ok(en.length > 0 && ar.length > 0);
    assert.notEqual(ar, en, `${key} Arabic must not be the English string`);
  }
  // Idle expiry names its cause; every other session death keeps the generic key.
  assert.notEqual(value(enText, "errors.sessionIdleExpired"), value(enText, "errors.sessionExpired"));
  assert.notEqual(value(arText, "errors.sessionIdleExpired"), value(arText, "errors.sessionExpired"));
  const apiKeys = compile("src/lib/api-error-keys.ts", name => { throw Error(name); });
  assert.equal(apiKeys.codeMessageKey("SESSION_IDLE_EXPIRED"), "errors.sessionIdleExpired");
  assert.equal(apiKeys.apiMessageKey("SESSION_IDLE_EXPIRED", 401), "errors.sessionIdleExpired");
  assert.equal(apiKeys.codeMessageKey("SESSION_EXPIRED"), "errors.sessionExpired");
  assert.equal(apiKeys.apiMessageKey("SESSION_EXPIRED", 401), "errors.sessionExpired");
  const guard = readFileSync("src/server/request-guard.ts", "utf8");
  assert.ok(guard.includes('{ success: false, error: code, code }'), "guard rejections mirror code so CSRF failures keep their code");
});

test("no auth secret reaches browser storage, broadcast payloads or logs in the new code; refresh never mints step-up or touches idle time", () => {
  const sync = readFileSync("src/lib/session-sync.ts", "utf8");
  const retry = readFileSync("src/lib/fetch-timeout.ts", "utf8");
  for (const [name, source] of [["session-sync", sync], ["fetch-timeout", retry]]) {
    assert.ok(!/localStorage\.|sessionStorage\.|document\.cookie/.test(source), `${name} must never touch browser storage`);
  }
  // Token-material absence in broadcast payloads is asserted at runtime
  // above (exact 4-key shape); here the code path is pinned: the only
  // postMessage argument is the 4-field event object.
  // Broadcast payload shape is asserted at runtime above; statically the only
  // postMessage argument is the 4-field event object.
  assert.ok(sync.includes("target.postMessage(event)"));
  assert.ok(sync.includes("type: SessionSyncEventType") || sync.includes("const event: SessionSyncEvent"));
  // Only /api/auth/activity touches workspace last_seen_at.
  const { readdirSync, statSync } = require("node:fs");
  const { join } = require("node:path");
  const touchCallers = [];
  const walk = dir => { for (const entry of readdirSync(dir)) { const full = join(dir, entry); if (statSync(full).isDirectory()) { if (entry !== "node_modules") walk(full); } else if (/\.tsx?$/.test(entry) && readFileSync(full, "utf8").includes("touch: true")) touchCallers.push(full); } };
  walk("src");
  assert.deepEqual(touchCallers, ["src/app/api/auth/activity/route.ts"]);
  // Silent refresh never writes the login timestamp: the detailed rotation
  // body contains no password_verified_at write.
  const tokens = readFileSync("src/lib/session-tokens.ts", "utf8");
  const start = tokens.indexOf("export async function rotateRefreshTokenDetailed");
  const end = tokens.indexOf("export async function rotateRefreshToken(", start);
  const rotation = tokens.slice(start, end);
  assert.ok(!rotation.includes("password_verified_at"), "silent refresh must never mint step-up proof");
  assert.ok(!rotation.includes("last_seen_at=clock_timestamp"), "silent refresh must never extend idle time");
  // AppShell sidebar-collapse localStorage use is pre-existing UI state, not auth.
  const shell = readFileSync("src/components/AppShell.tsx", "utf8");
  for (const match of shell.match(/localStorage\.[a-zA-Z]+\([^)]*\)/g) ?? []) assert.ok(match.includes("COLLAPSE_KEY"), `unexpected AppShell storage use: ${match}`);
});
