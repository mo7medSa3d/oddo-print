/** Execute the production component with deterministic React/router/network
 * boundaries. Navigation cancellation is separate from server commit status. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function harness(fetch) {
  const states = [], refs = [], effects = [], scheduled = [], navigation = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const router = { replace: path => navigation.push(["replace", path]), refresh: () => navigation.push(["refresh"]) };
  const react = {
    useState(initial) { const i = stateIndex++; if (!(i in states)) states[i] = initial;
      return [states[i], next => { states[i] = typeof next === "function" ? next(states[i]) : next; }]; },
    useRef(initial) { const i = refIndex++; return refs[i] ??= { current: initial }; },
    useEffect(fn, deps) { const i = effectIndex++; if (!effects[i] || !same(effects[i].deps, deps)) scheduled.push({ i, fn, deps }); },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const imports = name => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "next/navigation") return { useRouter: () => router };
    if (name.endsWith("/fetch-timeout")) return { fetchWithTimeout: fetch };
    if (name.endsWith("/i18n/react")) return { useI18n: () => ({ t: key => key }) };
    if (name.endsWith("/api-error-keys")) return { codeMessageKey: () => null };
    if (name.endsWith("/AuthShell")) return { AuthShell: "AuthShell" };
    if (name.endsWith("/ui") || name === "lucide-react") return new Proxy({}, { get: (_target, key) => String(key) });
    throw Error("Unexpected platform login dependency " + name);
  };
  const compiled = ts.transpileModule(readFileSync("src/app/platform/login/page.tsx", "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const entry = { exports: {} };
  new Function("require", "module", "exports", compiled)(imports, entry, entry.exports);
  return { states, navigation, tree: null,
    render() { stateIndex = refIndex = effectIndex = 0; this.tree = entry.exports.default(); return this.tree; },
    effects() { while (scheduled.length) { const item = scheduled.shift(); effects[item.i]?.cleanup?.(); effects[item.i] = { deps: item.deps, cleanup: item.fn() }; } },
    cleanup() { for (const effect of effects) effect?.cleanup?.(); },
  };
}
function find(value, predicate) {
  if (!value || typeof value !== "object") return;
  if (predicate(value)) return value;
  return Object.values(value).map(child => find(child, predicate)).find(Boolean);
}
const input = (h, id) => find(h.tree, node => node.props?.id === id);
const form = h => find(h.tree, node => node.type === "form");
async function mount(fetch) { const h = harness(fetch); h.render(); h.effects(); await flush(); h.render(); return h; }
function type(h, id, value) { input(h, id).props.onChange({ target: { value } }); h.render(); }
const event = { preventDefault() {} };

test("same-frame platform submissions send the exact password once and clear the input", async () => {
  const pending = deferred(), requests = [];
  const h = await mount(async (path, init) => { requests.push({ path, init }); return path.endsWith("/login") ? pending.promise : reply(401); });
  const password = "  exact كلمة المرور\t";
  type(h, "platform-email", "owner@example.test"); type(h, "platform-password", password);
  const submit = form(h).props.onSubmit;
  const first = submit(event), second = submit(event);
  await flush(); h.render();
  assert.equal(requests.filter(request => request.path.endsWith("/login")).length, 1);
  assert.equal(JSON.parse(requests.at(-1).init.body).password, password);
  assert.equal(input(h, "platform-password").props.value, "");
  pending.resolve(reply(200, { ok: true })); await Promise.all([first, second]);
  assert.deepEqual(h.navigation, [["replace", "/platform/dashboard"], ["refresh"]]);
  h.cleanup();
});

test("unmount aborts platform login and a late successful result cannot redirect the next page", async () => {
  const pending = deferred(); let request;
  const h = await mount(async (path, init) => { if (path.endsWith("/login")) { request = init; return pending.promise; } return reply(401); });
  type(h, "platform-password", "a password");
  const submission = form(h).props.onSubmit(event); h.cleanup();
  pending.resolve(reply(200, { ok: true })); await submission;
  assert.deepEqual(h.navigation, []);
  assert.equal(request.signal?.aborted, true);
});

test("unmount aborts the session probe and suppresses a later refresh request", async () => {
  const pending = deferred(), requests = [];
  const h = harness(async (path, init) => { requests.push({ path, init }); return pending.promise; });
  h.render(); h.effects(); h.cleanup();
  pending.resolve(reply(401)); await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.signal?.aborted, true);
  assert.deepEqual(h.navigation, []);
});

test("a late unsuccessful login cannot write error or loading state after unmount", async () => {
  const pending = deferred();
  const h = await mount(async path => path.endsWith("/login") ? pending.promise : reply(401));
  type(h, "platform-password", "a password");
  const submission = form(h).props.onSubmit(event); h.cleanup();
  const atUnmount = [...h.states];
  pending.resolve(reply(401)); await submission;
  assert.deepEqual(h.states, atUnmount);
  assert.deepEqual(h.navigation, []);
});
