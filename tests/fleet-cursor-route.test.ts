import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ServerResponse } from "node:http";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), permission: vi.fn(), chain: { select: vi.fn(), from: vi.fn(), leftJoin: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), offset: vi.fn() } }));
vi.mock("../src/db", () => ({ db: { select: mocks.chain.select } }));
vi.mock("../src/lib/console-auth", () => ({ validateConsoleAuth: mocks.auth }));
vi.mock("../src/lib/manager-auth", () => ({ validateWorkspaceManager: mocks.auth }));
vi.mock("../src/lib/authorization", () => ({ requireManagerPermission: mocks.permission }));
vi.mock("../src/lib/agent-control", () => ({ createAgentForManager: vi.fn() }));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: vi.fn() }));
vi.mock("../src/lib/entitlements", () => ({ enforceTenantResourceEntitlement: vi.fn(), TenantEntitlementError: class extends Error {}, isTenantBillingError: () => false }));
vi.mock("../src/lib/database-clock", () => ({ gatewayNow: () => new Date("2026-10-07T12:00:00Z"), refreshClockSkew: async () => {} }));
import { GET as getPrinters } from "../src/app/api/printers/route";
import { GET as getAgents } from "../src/app/api/agents/route";
import { applyApiCors } from "../src/server/cors";

const boundaryTime = "2026-10-07T10:00:00.000Z";
const baseRow = (id: string) => ({ id, tenantId: "tenant-a", name: id, agentId: "agent-a", status: "unknown", lifecycle: "active", createdAt: new Date(boundaryTime), lastSeenAt: null, config: {}, managementSource: "agent" });

describe.each([["printers", getPrinters], ["agents", getAgents]] as const)("%s fleet cursor HTTP/DB boundary", (kind, get) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ kind: "manager", claims: { tenantId: "tenant-a", role: "admin" } });
    mocks.permission.mockImplementation(() => {});
    for (const method of [mocks.chain.select, mocks.chain.from, mocks.chain.leftJoin, mocks.chain.where, mocks.chain.orderBy, mocks.chain.limit]) method.mockReturnValue(mocks.chain);
  });

  function rows(id: string) {
    mocks.chain.offset.mockResolvedValue([baseRow(id), baseRow("sentinel")].map(row => kind === "printers" ? { printer: row, agent: null } : row));
  }

  it.each(["طابعة-1", "printer\n1", "printer 1"])("returns a traversable page for unsafe raw header ID %s", async id => {
    rows(id);
    const response = await get(new Request(`http://gateway.test/api/${kind}?limit=1`));
    expect(response.status).toBe(200);
    expect((await response.json())[0].id).toBe(id);
    expect(response.headers.get("X-Next-Before-Id")).toBeNull();
    const encoded = response.headers.get("X-Next-Before-Id-Encoded")!;
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(id);
    const params = new URLSearchParams({ beforeCreatedAt: response.headers.get("X-Next-Before-Created-At")!, beforeIdEncoded: encoded, limit: "1" });
    const next = await get(new Request(`http://gateway.test/api/${kind}?${params}`));
    expect(next.status).toBe(200);
    const query = new PgDialect().sqlToQuery(mocks.chain.where.mock.calls[1][0]);
    expect(query.params).toContain("tenant-a");
    expect(query.params).toContain(id);
    expect(mocks.chain.offset).toHaveBeenLastCalledWith(0);
  });

  it("preserves the safe legacy ASCII header and input", async () => {
    rows("printer_1");
    const response = await get(new Request(`http://gateway.test/api/${kind}?limit=1&beforeCreatedAt=${boundaryTime}&beforeId=printer_0`));
    expect(response.headers.get("X-Next-Before-Id")).toBe("printer_1");
    expect(new PgDialect().sqlToQuery(mocks.chain.where.mock.calls[0][0]).params).toContain("printer_0");
  });

  it.each(["", "!", "a", "_w", "YQ==", "a".repeat(2733), Buffer.from("x".repeat(513)).toString("base64url")])("rejects malformed encoded cursor before DB access (%s)", async encoded => {
    const params = new URLSearchParams({ beforeCreatedAt: boundaryTime, beforeIdEncoded: encoded });
    expect((await get(new Request(`http://gateway.test/api/${kind}?${params}`))).status).toBe(400);
    expect(mocks.chain.select).not.toHaveBeenCalled();
  });

  it("rejects conflicting legacy/encoded cursor IDs", async () => {
    const params = new URLSearchParams({ beforeCreatedAt: boundaryTime, beforeId: "other", beforeIdEncoded: Buffer.from("printer_1").toString("base64url") });
    expect((await get(new Request(`http://gateway.test/api/${kind}?${params}`))).status).toBe(400);
    expect(mocks.chain.select).not.toHaveBeenCalled();
  });

  it("preserves authentication and RBAC before cursor processing", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await get(new Request(`http://gateway.test/api/${kind}?beforeIdEncoded=!`))).status).toBe(401);
    mocks.auth.mockResolvedValue({ kind: "manager", claims: { tenantId: "tenant-a" } });
    mocks.permission.mockImplementation(() => { throw new Error("Forbidden"); });
    expect((await get(new Request(`http://gateway.test/api/${kind}?beforeIdEncoded=!`))).status).toBe(403);
    expect(mocks.chain.select).not.toHaveBeenCalled();
  });
});

it("exposes traversal metadata only to an already allowed desktop origin", () => {
  const setHeader = vi.fn();
  const response = { setHeader } as unknown as ServerResponse;
  expect(applyApiCors({ url: "/api/printers", headers: { origin: "https://foreign.test" } }, response)).toBe(false);
  expect(setHeader).not.toHaveBeenCalled();
  expect(applyApiCors({ url: "/api/printers", headers: { origin: "tauri://localhost" } }, response)).toBe(true);
  const exposed = setHeader.mock.calls.find(([key]) => key === "Access-Control-Expose-Headers")?.[1];
  expect(exposed.split(",")).toEqual(expect.arrayContaining(["X-Request-Id", "X-Next-Cursor", "X-Next-Before-Id-Encoded", "X-Has-More"]));
  expect(setHeader).toHaveBeenCalledWith("Access-Control-Allow-Credentials", "false");
});
