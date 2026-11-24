import { describe, expect, it, vi, afterEach } from "vitest";
import { ensureCustomerSession, refreshEndpointOrder } from "../src/lib/session-config";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("manager/customer refresh recovery", () => {
  it("prefers the indicated kind but falls back to the other on 401", () => {
    expect(refreshEndpointOrder("manager")).toEqual(["/api/auth/manager/refresh", "/api/auth/refresh"]);
    expect(refreshEndpointOrder("customer")).toEqual(["/api/auth/refresh", "/api/auth/manager/refresh"]);
  });

  it("recovers a live manager family when the expired access cookie is invisible to the probe", async () => {
    // The mgr_session access cookie expired, so the browser no longer sends
    // it and /api/auth/me cannot report refreshKind=manager. The probe sees
    // a customer-shaped 401, but the mgr_refresh family is still alive.
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(url);
      if (url === "/api/auth/me") return jsonResponse(401, { error: "Unauthorized", refreshKind: "customer" });
      if (url === "/api/auth/refresh") return jsonResponse(401, { error: "Unauthorized" });
      if (url === "/api/auth/manager/refresh") {
        return jsonResponse(200, { expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const result = await ensureCustomerSession();
    expect(result.authenticated).toBe(true);
    expect(seen).toEqual(["/api/auth/me", "/api/auth/refresh", "/api/auth/manager/refresh"]);
  });

  it("reports signed out only after both families reject", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return jsonResponse(401, { error: "Unauthorized", refreshKind: "customer" });
      return jsonResponse(401, { error: "Unauthorized" });
    }));

    const result = await ensureCustomerSession();
    expect(result).toEqual({ authenticated: false, expiresAt: 0 });
  });

  it("keeps manager precedence when the probe indicates a manager session", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(url);
      if (url === "/api/auth/me") return jsonResponse(401, { error: "Unauthorized", refreshKind: "manager" });
      if (url === "/api/auth/manager/refresh") {
        return jsonResponse(200, { expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const result = await ensureCustomerSession();
    expect(result.authenticated).toBe(true);
    expect(seen).toEqual(["/api/auth/me", "/api/auth/manager/refresh"]);
  });
});
