import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("browser session admission", () => {
  it("shares and resolves one locked refresh for concurrent callers", async () => {
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const request = vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback());
    vi.stubGlobal("navigator", { locks: { request } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ expiresAt })));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureCustomerSession } = await import("../src/lib/session-config");
    const first = ensureCustomerSession();
    const second = ensureCustomerSession();
    expect(first).toBe(second);
    expect(await first).toEqual({ authenticated: true, expiresAt: Date.parse(expiresAt) });
    expect(request).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/auth/me", "/api/auth/refresh"]);
  });

  it("clears failed admission so a later request can recover", async () => {
    vi.stubGlobal("navigator", {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })));
    vi.stubGlobal("fetch", fetchMock);
    const { ensureCustomerSession } = await import("../src/lib/session-config");
    await expect(ensureCustomerSession()).rejects.toThrow("temporarily unavailable");
    expect((await ensureCustomerSession()).authenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns unauthenticated when refresh credentials are rejected", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    const { ensureCustomerSession } = await import("../src/lib/session-config");
    expect(await ensureCustomerSession()).toEqual({ authenticated: false, expiresAt: 0 });
  });
});
