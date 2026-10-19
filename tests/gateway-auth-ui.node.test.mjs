/** Actual component/effect bodies with deterministic React/network boundaries.
 * No live browser, authenticated service or visual acceptance is claimed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function component(file, fetch, session = async () => ({ authenticated: true }), options = {}) {
  const states = [], effects = [], callbacks = [], refs = [], timers = new Set(), redirects = [];
  let stateCursor = 0, refCursor = 0;
  const react = {
    useState(initial) {
      const slot = stateCursor++;
      if (!(slot in states)) states[slot] = initial;
      return [states[slot], next => { states[slot] = typeof next === "function" ? next(states[slot]) : next; }];
    },
    useRef(initial) { const slot = refCursor++; if (!refs[slot]) refs[slot] = { current: initial }; return refs[slot]; },
    useEffect(effect) { effects.push(effect); },
    useCallback(callback) { callbacks.push(callback); return callback; },
    Suspense: "Suspense",
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const imports = name => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    if (name === "next/navigation") return {
      usePathname: () => "/platform/dashboard",
      useRouter: () => ({ replace: value => redirects.push(value), push() {}, refresh() {} }),
      useSearchParams: () => new URLSearchParams(options.search ?? ""),
    };
    if (name.endsWith("/fetch-timeout")) return { fetchWithTimeout: fetch };
    if (name.endsWith("/session-config")) return { ensureCustomerSession: session };
    if (name.endsWith("/i18n/react")) return { useI18n: () => ({ t: value => value, tc: value => value, formatNumber: String, formatDate: String, formatDateTime: String }) };
    if (name.endsWith("/api-error-keys")) return { codeMessageKey: () => undefined, apiMessageKey: () => undefined };
    if (name.endsWith("/clipboard")) return { copyTextToClipboard: async () => true };
    if (name === "next/link") return "Link";
    if (name.endsWith("/roles")) return { roleLabel: value => value };
    if (name.endsWith("/utils")) return { shortId: value => value };
    if (name === "lucide-react" || name.endsWith("/components/ui") || name === "../ui" || name.endsWith("/components/AuthShell") || name.endsWith("/platform/PlatformSidebar")
      || ["/brand", "/visual-system", "/MobileAppBar", "/LanguageSwitcher", "/ThemeToggle"].some(suffix => name.endsWith(suffix))) {
      return new Proxy({}, { get: (_object, key) => key === "useDialog" ? () => {} : String(key) });
    }
    throw Error(`Unexpected auth UI import: ${name}`);
  };
  const js = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const entry = { exports: {} };
  // Only checked-in source is executed; no untrusted string enters this loader.
  new Function("require", "module", "exports", "setTimeout", "clearTimeout", "document", "window", js)(
    imports, entry, entry.exports,
    callback => { timers.add(callback); return callback; },
    callback => timers.delete(callback),
    { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
    { location: { origin: "https://gateway.test", search: options.search ?? "" }, matchMedia: options.matchMedia },
  );
  const harness = { states, effects, callbacks, refs, timers, redirects, tree: null, render() {
    stateCursor = 0; refCursor = 0;
    this.tree = entry.exports[options.exportName ?? "default"](options.props ?? { children: null });
    if (typeof this.tree?.props?.children?.type === "function") this.tree = this.tree.props.children.type();
    return this.tree;
  } };
  harness.render();
  return harness;
}

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean);
  if (!tree || typeof tree !== "object") return undefined;
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}

test("platform expired access plus refresh503 displays retry feedback without signing out", async () => {
  const harness = component("src/app/platform/layout.tsx", async url => ({
    ok: false, status: url.endsWith("/me") ? 401 : 503,
  }));
  const cleanup = harness.effects[0]();
  await flush();
  assert.equal(harness.states[0], null);
  assert.equal(harness.states[1], true, "first recovery failure must leave the indefinite checking skeleton");
  assert.deepEqual(harness.redirects, []);
  assert.equal(harness.timers.size, 1, "existing bounded recovery retry is retained");
  cleanup();
  assert.equal(harness.timers.size, 0);
});

test("platform first refresh transport failure also exposes retryable state", async () => {
  const harness = component("src/app/platform/layout.tsx", async url => {
    if (url.endsWith("/me")) return { ok: false, status: 401 };
    throw new TypeError("network unavailable");
  });
  const cleanup = harness.effects[0]();
  await flush();
  assert.equal(harness.states[1], true);
  assert.deepEqual(harness.redirects, []);
  cleanup();
});

test("platform probe body completing after unmount cannot authenticate or schedule refresh", async () => {
  const body = deferred();
  const harness = component("src/app/platform/layout.tsx", async () => ({ ok: true, json: () => body.promise }));
  const cleanup = harness.effects[0]();
  await flush();
  cleanup();
  body.resolve({ exp: Math.floor(Date.now() / 1000) + 900 });
  await flush();
  assert.equal(harness.states[0], null);
  assert.equal(harness.timers.size, 0);
});

test("team generation fence spans both response bodies and preserves the newer snapshot", async () => {
  const oldMembers = deferred();
  let membersRequest = 0, invitationsRequest = 0;
  const freshMembers = [{ userId: "new-user", email: "new@example.test", role: "viewer" }];
  const freshInvitations = [{ id: "new-invitation", email: "new-invite@example.test" }];
  const harness = component("src/app/team/page.tsx", async url => {
    if (url.endsWith("/me")) return { ok: true, json: async () => ({ userId: "actor", permissions: ["users.read"] }) };
    if (url.includes("/members?")) {
      membersRequest += 1;
      return { ok: true, json: () => membersRequest === 1 ? oldMembers.promise : Promise.resolve({ members: freshMembers, total: 1 }) };
    }
    invitationsRequest += 1;
    const stale = invitationsRequest === 1;
    return { ok: true, json: async () => ({ invitations: stale ? [{ id: "old-invitation" }] : freshInvitations, total: 1 }) };
  });
  const load = harness.callbacks[0];
  const old = load(0, 0);
  await flush();
  await load(0, 0);
  assert.deepEqual(harness.states[0], freshMembers);
  assert.deepEqual(harness.states[1], freshInvitations);
  oldMembers.resolve({ members: [{ userId: "old-user" }], total: 1 });
  await old;
  assert.deepEqual(harness.states[0], freshMembers);
  assert.deepEqual(harness.states[1], freshInvitations);
});

test("unmounted team admission cannot redirect a newer page to login", async () => {
  const session = deferred();
  const harness = component("src/app/team/page.tsx", async () => { throw Error("stale admission must not fetch"); }, () => session.promise);
  const cleanup = harness.effects[0]();
  await flush();
  cleanup();
  session.resolve({ authenticated: false });
  await flush();
  assert.deepEqual(harness.redirects, []);
  assert.equal(harness.states[8], false, "stale load does not mark the current page loaded");
});

test("email proof follows the server password-setup step while preserving invitation and plan context", async () => {
  const harness = component("src/app/verify-email/page.tsx", async () => ({ ok: true, json: async () => ({ next: "/reset-password?token=owner-proof&setup=1" }) }), undefined,
    { search: "token=mail-proof&plan=selected-plan&invite=invitation-proof" });
  const cleanup = harness.effects[0]();
  await flush();
  assert.equal(harness.timers.size, 1);
  [...harness.timers][0]();
  const destination = new URL(harness.redirects[0], "https://gateway.test");
  assert.equal(destination.pathname, "/reset-password");
  assert.equal(destination.searchParams.get("token"), "owner-proof");
  assert.equal(destination.searchParams.get("setup"), "1");
  assert.equal(destination.searchParams.get("plan"), "selected-plan");
  assert.equal(destination.searchParams.get("invite"), "invitation-proof");
  cleanup();
});

test("email proof refuses a cross-origin account continuation", async () => {
  const harness = component("src/app/verify-email/page.tsx", async () => ({ ok: true, json: async () => ({ next: "https://other.example/reset-password?token=secret" }) }), undefined,
    { search: "token=different-mail-proof" });
  const cleanup = harness.effects[0]();
  await flush();
  assert.equal(harness.states[0], "error");
  assert.equal(harness.timers.size, 0);
  assert.deepEqual(harness.redirects, []);
  cleanup();
});

test("password setup returns to normal sign-in with invitation context and cancels an abandoned redirect", async () => {
  const harness = component("src/app/reset-password/page.tsx", async () => ({ ok: true, json: async () => ({ ok: true }) }), undefined,
    { search: "token=owner-proof&setup=1&invite=invitation-proof" });
  find(harness.tree, node => node.props?.id === "password").props.onChange({ target: { value: "owner-new-password-123" } });
  harness.render();
  await find(harness.tree, node => node.type === "form").props.onSubmit({ preventDefault() {} });
  harness.render();
  const cleanup = harness.effects.at(-1)();
  assert.equal(harness.timers.size, 1);
  const link = find(harness.tree, node => typeof node.props?.href === "string");
  const signIn = new URL(link.props.href, "https://gateway.test");
  assert.equal(signIn.pathname, "/login");
  assert.equal(signIn.searchParams.get("next"), "/invite?token=invitation-proof");
  cleanup();
  assert.equal(harness.timers.size, 0);
  assert.deepEqual(harness.redirects, []);
});

test("clearing the settings draft remains intentional across a locale reload", async () => {
  const harness = component("src/app/settings/page.tsx", async () => ({ ok: true, json: async () => ({ tenant: { name: "Saved workspace" } }) }));
  const cleanup = harness.effects[0]();
  await flush();
  harness.render();
  find(harness.tree, node => node.props?.id === "workspace-name").props.onChange({ target: { value: "" } });
  cleanup();
  harness.render();
  const nextCleanup = harness.effects.at(-1)();
  await flush();
  assert.equal(harness.states[0], "");
  nextCleanup();
});

test("same-frame API-key generation submits one mutation and retains its one-time secret", async () => {
  const response = deferred();
  let mutations = 0;
  const harness = component("src/app/api-keys/page.tsx", async (url, init) => {
    if (init?.method === "POST") { mutations += 1; return response.promise; }
    return { ok: true, json: async () => [] };
  });
  const submit = find(harness.tree, node => node.type === "form").props.onSubmit;
  submit({ preventDefault() {} });
  submit({ preventDefault() {} });
  await flush();
  assert.equal(mutations, 1);
  response.resolve({ ok: true, json: async () => ({ id: "new-key-id", apiKey: "shown-once-secret" }) });
  await flush();
  assert.equal(harness.states[3], "shown-once-secret");
});

test("Platform mobile drawer closes when CSS switches to desktop, then removes its breakpoint listener", () => {
  let changed, removed;
  const desktop = { matches: false, addEventListener: (_event, listener) => { changed = listener; }, removeEventListener: (_event, listener) => { removed = listener; } };
  const harness = component("src/components/platform/PlatformSidebar.tsx", undefined, undefined, {
    exportName: "PlatformSidebar", props: { items: [], onLogout() {}, loggingOut: false, children: null },
    matchMedia: query => { assert.equal(query, "(min-width: 1024px)"); return desktop; },
  });
  const cleanup = harness.effects[0]();
  find(harness.tree, node => node.type === "MobileAppBar").props.onOpenNavigation();
  harness.render();
  assert.ok(find(harness.tree, node => node.props?.role === "dialog"));
  desktop.matches = true;
  changed();
  harness.render();
  assert.equal(find(harness.tree, node => node.props?.role === "dialog"), undefined);
  cleanup();
  assert.equal(removed, changed);
});
