// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionInventory } from "../src/components/SessionInventory";

const fixture = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  return { fetch: vi.fn(), replace, refresh, router: { replace, refresh },
    t: (key: string) => key, formatDate: (value: string) => `formatted:${value}` };
});
// SessionInventory now routes workspace loads/mutations through
// fetchWithSessionRetry (silent refresh + retry once); the platform variant
// keeps fetchWithTimeout. Both resolve to the same fixture fetch here — the
// wrapper's own refresh/retry decisions are covered by
// tests/session-renewal-sync.node.test.mjs, so component assertions on the
// fixture calls (counts, bodies, serialization, abort) are unchanged.
vi.mock("../src/lib/fetch-timeout", () => ({ fetchWithTimeout: fixture.fetch, fetchWithSessionRetry: fixture.fetch }));
vi.mock("../src/i18n/react", () => ({ useI18n: () => ({ t: fixture.t, formatDate: fixture.formatDate }) }));
vi.mock("next/navigation", () => ({ useRouter: () => fixture.router }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLDivElement;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const row = (n: number) => ({ id: n.toString(16).padStart(32, "0"), kind: "customer", tenantId: "own-tenant", tenantName: `Workspace ${n}`,
  current: n === 0, createdAt: "2030-01-01T00:00:00Z", lastRefreshedAt: "2030-01-01T00:00:00Z",
  expiresAt: "2030-01-31T00:00:00Z", ipAddress: null, userAgent: `Synthetic device ${n}` });
const page = { sessions: [row(0), row(1)], truncated: false, nextCursor: null };
const button = (text: string) => [...host.querySelectorAll("button")].find(node => node.textContent === text)!;
async function mount(strict = false) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(strict ? h(StrictMode, null, h(SessionInventory)) : h(SessionInventory)));
}
beforeEach(() => { fixture.fetch.mockReset(); fixture.replace.mockReset(); fixture.refresh.mockReset(); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });

describe("account session security UI", () => {
  it("requires explicit all-device confirmation and revokes without a password", async () => {
    fixture.fetch.mockImplementation(async (_url, init) => init.method === "POST" ? reply(200, { signedOut: true }) : reply(200, page));
    await mount(); const all = host.querySelector<HTMLButtonElement>("#session-revoke-all")!;
    expect(all.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>("#session-confirm-all")!.click());
    expect(all.disabled).toBe(false); await act(async () => all.click());
    const posts = fixture.fetch.mock.calls.filter(([, init]) => init.method === "POST");
    expect(posts).toHaveLength(1); expect(JSON.parse(posts[0][1].body)).toEqual({ action: "revoke_all" });
    expect(fixture.replace).toHaveBeenCalledWith("/login"); expect(fixture.refresh).toHaveBeenCalledTimes(1);
    expect(host.querySelector("#session-password")).toBeNull();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it("serializes rapid revocation clicks and reports a generic failure without a platform prompt", async () => {
    const pending = deferred<Response>();
    fixture.fetch.mockImplementation((_url, init) => init.method === "POST" ? pending.promise : Promise.resolve(reply(200, page)));
    await mount();
    const others = button("security.revokeOthers");
    await act(async () => { others.click(); others.click(); });
    expect(fixture.fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    await act(async () => pending.resolve(reply(403, { code: "PLATFORM_AUTHORITY_CHANGED" })));
    expect(host.querySelector('a[href="/platform/security"]')).toBeNull();
    expect(host.textContent).toContain("security.sessionsFailed");
    expect(fixture.fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(fixture.replace).not.toHaveBeenCalled();
  });

  it("replaces bounded pages, preserves opaque cursors, and offers return to the first page", async () => {
    fixture.fetch.mockImplementation(async url => String(url).includes("?cursor=")
      ? reply(200, { sessions: [row(100), row(101)], truncated: false, nextCursor: null })
      : reply(200, { sessions: Array.from({ length: 100 }, (_, n) => row(n)), truncated: true, nextCursor: "opaque.cursor" }));
    await mount(); expect(host.querySelectorAll("li")).toHaveLength(100);
    await act(async () => host.querySelector<HTMLButtonElement>("#session-next-page")!.click());
    expect(fixture.fetch.mock.calls.at(-1)![0]).toBe("/api/auth/sessions?cursor=opaque.cursor");
    expect(host.querySelectorAll("li")).toHaveLength(2); expect(host.textContent).not.toContain("Synthetic device 0");
    await act(async () => button("security.firstSessions").click());
    expect(host.querySelectorAll("li")).toHaveLength(100);
    expect(fixture.fetch.mock.calls.every(([, init]) => init.credentials === "include" && init.cache === "no-store")).toBe(true);
  });

  it("aborts a pending mutation on unmount and never follows its late successful sign-out", async () => {
    const pending = deferred<Response>();
    fixture.fetch.mockImplementation((_url, init) => init.method === "POST" ? pending.promise : Promise.resolve(reply(200, page)));
    await mount();
    await act(async () => button("security.revokeOthers").click());
    const init = fixture.fetch.mock.calls.find(([, value]) => value.method === "POST")![1];
    await act(async () => root!.unmount()); root = undefined;
    expect(init.signal.aborted).toBe(true);
    await act(async () => pending.resolve(reply(200, { signedOut: true })));
    expect(fixture.replace).not.toHaveBeenCalled(); expect(fixture.refresh).not.toHaveBeenCalled();
  });

  it("ignores an obsolete first request after StrictMode effect replay", async () => {
    const old = deferred<Response>(); let reads = 0;
    fixture.fetch.mockImplementation(() => ++reads === 1 ? old.promise : Promise.resolve(reply(200, page)));
    await mount(true); expect(reads).toBe(2); expect(fixture.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => old.resolve(reply(401, { error: "expired obsolete request" })));
    expect(host.querySelectorAll("li")).toHaveLength(2); expect(host.textContent).not.toContain("security.sessionsFailed");
  });

  it("does not automatically retry an ambiguous network failure", async () => {
    fixture.fetch.mockImplementation(async (_url, init) => { if (init.method === "POST") throw new TypeError("offline"); return reply(200, page); });
    await mount(); await act(async () => button("security.revokeOthers").click());
    expect(fixture.fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(fixture.replace).not.toHaveBeenCalled(); expect(host.textContent).toContain("security.sessionsFailed");
  });
});
