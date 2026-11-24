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
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
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
    // Workspace pages now route through fetchWithSessionRetry (silent
    // refresh + retry once) and the platform layout subscribes to
    // session-sync; both resolve to the harness fetch / no-op stubs here.
    // The wrapper's own refresh decisions are covered by
    // tests/session-renewal-sync.node.test.mjs, so component assertions on
    // the fixture fetch calls are unchanged.
    if (name.endsWith("/fetch-timeout")) return { fetchWithTimeout: fetch, fetchWithSessionRetry: fetch, isSessionRenewedNotResent: response => { try { return response.headers?.get("X-Yaseir-Session-Renewed") === "1"; } catch { return false; } } };
    if (name.endsWith("/session-sync")) return { subscribeSessionSync: () => () => undefined, broadcastSessionSync: () => undefined };
    if (name.endsWith("/session-config")) return { ensureCustomerSession: session };
    if (name.endsWith("/i18n/react")) return { useI18n: () => ({ t: value => value, tc: value => value, formatNumber: String, formatDate: String, formatDateTime: String }) };
    if (name.endsWith("/api-error-keys")) return { codeMessageKey: () => undefined, apiMessageKey: () => undefined };
    if (name.endsWith("/clipboard")) return { copyTextToClipboard: async () => true };
    if (name === "next/link") return "Link";
    if (name.endsWith("/roles")) return { roleLabel: value => value };
    if (name.endsWith("/utils")) return { shortId: value => value };
    if (name === "lucide-react" || name.endsWith("/components/ui") || name === "../ui" || name.endsWith("/components/AuthShell") || name.endsWith("/platform/PlatformSidebar")
      || ["/brand", "/visual-system", "/MobileAppBar", "/LanguageSwitcher", "/ThemeToggle", "/SessionInventory", "/WorkspaceSecurity"].some(suffix => name.endsWith(suffix))) {
      return new Proxy({}, { get: (_object, key) => key === "useDialog" || key === "useUnsavedChangesWarning" ? () => undefined : String(key) });
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
    { location: { origin: "https://gateway.test", search: options.search ?? "", hash: options.hash ?? "" }, matchMedia: options.matchMedia, addEventListener() {}, removeEventListener() {} },
  );
  const harness = { states, effects, callbacks, refs, timers, redirects, tree: null, render() {
    stateCursor = 0; refCursor = 0;
    this.tree = entry.exports[options.exportName ?? "default"](options.props ?? { children: null });
    if (typeof this.tree?.props?.children?.type === "function") this.tree = this.tree.props.children;
    while (typeof this.tree?.type === "function") this.tree = this.tree.type(this.tree.props);
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

test("workspace session inventory remains reachable while profile settings are pending or unavailable", async () => {
  const settings = deferred();
  const harness = component("src/app/settings/page.tsx", async url => {
    assert.equal(url, "/api/settings");
    return settings.promise;
  });
  const cleanup = harness.effects[0]();
  assert.ok(find(harness.tree, node => node.type === "SessionInventory"), "session inventory must be independent of profile loading");
  settings.resolve({ ok: false, status: 401 });
  await flush(); harness.render();
  assert.ok(find(harness.tree, node => node.type === "SessionInventory"));
  assert.deepEqual(harness.redirects, ["/login?next=%2Fsettings"]);
  cleanup();
});

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

test("verified owner Team page rejects stale late responses without hiding pending invitations", async () => {
  const oldMembers = deferred();
  let count = 0;
  const freshMembers = [{ userId: "new-user", email: "new@example.test", platformOwner: false }];
  const pending = [{ id: "invitation", email: "colleague@example.test", expiresAt: "2031-01-01T00:00:00Z" }];
  const harness = component("src/app/team/page.tsx", async url => {
    if (url.startsWith("/api/team/members?")) {
      count += 1;
      return { ok: true, json: () => count === 1 ? oldMembers.promise :
        Promise.resolve({ members: freshMembers, hasMore: false }) };
    }
    if (url.startsWith("/api/team/invitations?")) {
      return { ok: true, json: async () => ({ invitations: pending, hasMore: false }) };
    }
    if (url === "/api/settings") {
      return { ok: true, json: async () => ({ userId: "me", email: "me@example.test", role: "owner", platformOwner: false, tenant: { id: "tenant" } }) };
    }
    throw Error("Unexpected Team request: " + url);
  });
  const obsoleteCleanup = harness.effects[1]();
  await flush();
  obsoleteCleanup();
  harness.render();
  const currentCleanup = harness.effects.at(-1)();
  await flush();
  assert.deepEqual(harness.states[1], freshMembers);
  assert.deepEqual(harness.states[2], pending);
  oldMembers.resolve({ members: [{ userId: "stale-user" }], hasMore: false });
  await flush();
  assert.deepEqual(harness.states[1], freshMembers);
  currentCleanup();
});

test("Full Access Team never requests or renders pending invitation recipients", async () => {
  const calls = [];
  const members = [{ userId: "member", email: "member@example.test", platformOwner: false }];
  const harness = component("src/app/team/page.tsx", async url => {
    calls.push(url);
    if (url.startsWith("/api/team/members?")) {
      return { ok: true, json: async () => ({ members, hasMore: false }) };
    }
    if (url === "/api/settings") {
      return { ok: true, json: async () => ({ userId: "member", email: "member@example.test", role: "admin", platformOwner: true, tenant: { id: "tenant" } }) };
    }
    throw Error("Full Access attempted to read owner invitation data: " + url);
  });
  const cleanup = harness.effects[1]();
  await flush(); harness.render();
  assert.deepEqual(harness.states[1], members);
  assert.deepEqual(harness.states[2], []);
  assert.equal(find(harness.tree, node => node.type === "CardHeader" && node.props.title === "team.pendingInvitations"), undefined);
  assert.ok(calls.some(url => url === "/api/settings"));
  assert.ok(calls.every(url => !url.startsWith("/api/team/invitations?")));
  cleanup();
});

test("unmounted team membership admission cannot redirect an unrelated page", async () => {
  const session = deferred();
  const harness = component("src/app/team/page.tsx", async () => { throw Error("stale admission must not fetch"); }, () => session.promise);
  const cleanup = harness.effects[1]();
  await flush();
  cleanup();
  session.resolve({ authenticated: false });
  await flush();
  assert.deepEqual(harness.redirects, []);
  assert.equal(harness.states[8], true, "stale load cannot mark a newly-mounted page as loaded");
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

test("verified signup sets one password then continues to its workspace without another sign-in", async () => {
  const harness = component("src/app/reset-password/page.tsx", async () => ({ ok: true, json: async () => ({ ok: true, authenticated: true }) }), undefined,
    { search: "token=owner-proof&setup=1&invite=invitation-proof" });
  find(harness.tree, node => node.props?.id === "password").props.onChange({ target: { value: "owner-new-password-123" } });
  harness.render();
  await find(harness.tree, node => node.type === "form").props.onSubmit({ preventDefault() {} });
  // ResetPasswordForm registers its redirect timer before the focus-on-error
  // effect. Execute the first effect added by this completion render, not the
  // initial render's no-op or the later focus effect.
  const effectsBeforeCompletionRender = harness.effects.length;
  harness.render();
  const cleanup = harness.effects[effectsBeforeCompletionRender]();
  assert.equal(harness.timers.size, 1);
  const link = find(harness.tree, node => typeof node.props?.href === "string");
  const destination = new URL(link.props.href, "https://gateway.test");
  assert.equal(destination.pathname, "/invite");
  assert.equal(destination.searchParams.get("token"), "invitation-proof");
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
  const nextCleanup = harness.effects[0]();
  await flush();
  assert.equal(harness.states[0], "");
  nextCleanup();
});

test("same-frame API-key generation submits one mutation and retains its one-time secret", async () => {
  const response = deferred();
  let mutations = 0;
  const harness = component("src/app/api-keys/page.tsx", async (url, init) => {
    if (init?.method === "POST") { mutations += 1; return response.promise; }
    if (url === "/api/auth/me") return { ok: true, json: async () => ({ permissions: ["integrations.manage"] }) };
    if (url === "/api/subscription-requests") return { ok: true, json: async () => ({ status: "active", hasSubscription: true }) };
    return { ok: true, json: async () => [] };
  });
  const cleanups = harness.effects.map(effect => effect());
  await flush(); harness.render();
  const submit = find(harness.tree, node => node.type === "form").props.onSubmit;
  submit({ preventDefault() {} });
  submit({ preventDefault() {} });
  await flush();
  assert.equal(mutations, 1);
  response.resolve({ ok: true, json: async () => ({ id: "new-key-id", apiKey: "shown-once-secret" }) });
  await flush();
  harness.render();
  assert.ok(find(harness.tree, node => node.type === "code" && node.props.children === "shown-once-secret"));
  for (const cleanup of cleanups) cleanup?.();
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
