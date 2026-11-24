import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireManagerPermission } from "../src/lib/authorization";
import type { ManagerClaims } from "../src/lib/manager-auth";
import { flushAuthorizationDenials, recordAuthorizationDenial } from "../src/server/authorization-monitor";

beforeEach(() => flushAuthorizationDenials());
afterEach(() => { flushAuthorizationDenials(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const viewer: ManagerClaims = {
  jti: "session-private", iat: 1, exp: 100, sub: "manager", role: "viewer",
  tenantId: "tenant_fixture", userId: "user_fixture", familyId: "family-private",
};

describe("manager authorization denial evidence", () => {
  it("records the actual permission denial while preserving its 403 response and excluding session material", () => {
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => requireManagerPermission(viewer, "billing.manage")).toThrowError(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
    const rows = output.mock.calls.map(([line]) => JSON.parse(String(line)))
      .filter(row => row.event === "security.access.denied");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: "manager", status: 403, permission: "billing.manage", role: "viewer", actorId: "user_fixture", tenantId: "tenant_fixture", count: 1 });
    expect(JSON.stringify(rows)).not.toContain("session-private");
    expect(JSON.stringify(rows)).not.toContain("family-private");
  });

  it("does not label an authorized operation as denied", () => {
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => requireManagerPermission(viewer, "printers.read")).not.toThrow();
    expect(output).not.toHaveBeenCalled();
  });

  it("aggregates every excess denial within a bounded fixed category budget", () => {
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 1_000; i++) recordAuthorizationDenial("websocket", 401);
    expect(output).toHaveBeenCalledTimes(120);
    flushAuthorizationDenials();
    const rows = output.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(rows).toHaveLength(121);
    expect(rows.at(-1)).toMatchObject({ surface: "websocket", status: 401, count: 880, aggregated: true });
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(1_000);
  });

  it("flushes quiet overflow at the timer boundary and starts a new detail window", () => {
    vi.useFakeTimers();
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 125; i++) recordAuthorizationDenial("http", 403);
    vi.advanceTimersByTime(60_000);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ count: 5, aggregated: true });
    recordAuthorizationDenial("http", 403);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ count: 1, aggregated: false });
  });

  it("shares the output budget across separately loaded copies of the module", async () => {
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 120; i++) recordAuthorizationDenial("manager", 403);
    vi.resetModules();
    const second = await import("../src/server/authorization-monitor");
    second.recordAuthorizationDenial("http", 403);
    expect(output).toHaveBeenCalledTimes(120);
    second.flushAuthorizationDenials();
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ surface: "http", count: 1, aggregated: true });
  });

  it("retains security events at the strictest ordinary log level", () => {
    vi.stubEnv("LOG_LEVEL", "error");
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordAuthorizationDenial("http", 401);
    expect(output).toHaveBeenCalledTimes(1);
  });

  it("never allows malformed details or dynamic categories to expand the log schema", () => {
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordAuthorizationDenial("manager", 403, {
      role: "viewer\nforged-log", actorId: "a".repeat(129), tenantId: "tenant_fixture",
      permission: "billing.manage", cookie: "cookie-private", password: "password-private",
    } as Parameters<typeof recordAuthorizationDenial>[2]);
    recordAuthorizationDenial("attacker-category" as "http", 403);
    recordAuthorizationDenial("http", 12345);
    expect(output).toHaveBeenCalledTimes(1);
    const event = JSON.parse(String(output.mock.calls[0][0]));
    expect(event).toMatchObject({ tenantId: "tenant_fixture", permission: "billing.manage" });
    expect(event).not.toHaveProperty("role");
    expect(event).not.toHaveProperty("actorId");
    expect(event).not.toHaveProperty("cookie");
    expect(event).not.toHaveProperty("password");
    expect(JSON.stringify(event)).not.toContain("private");
  });

  it("preserves the original refusal when the operational log sink throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("synthetic sink outage"); });
    expect(() => requireManagerPermission(viewer, "billing.manage")).toThrowError(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
  });
});
