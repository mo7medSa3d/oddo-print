import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { DESIRED_STATE_PAGE_BYTES, DESIRED_STATE_PAGE_ROWS, getDesiredPrinterPage } from "../src/lib/desired-state-page";

const mocks = vi.hoisted(() => ({ read: vi.fn(), auth: vi.fn() }));
vi.mock("../src/db", () => ({ db: { query: { printers: { findMany: mocks.read } } } }));
vi.mock("../src/lib/agent-auth", () => ({ validateAgent: mocks.auth }));
import { GET } from "../src/app/api/agent/desired-state/route";

const row = (id: string, config = {}) => ({ id, name: id, printerType: "physical" as const, deviceClass: "other" as const, connectionType: "spooler" as const, protocol: "spooler" as const, lifecycle: "active" as const, config, desiredRevision: 1 });

describe("desired-state bounded query/response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ id: "agent-a", tenantId: "tenant-a" });
  });

  it("bounds the query before projection, scopes tenant/owner/manager and carries an exact cursor", async () => {
    const rows = Array.from({ length: DESIRED_STATE_PAGE_ROWS }, (_, i) => row(`printer-${i}`));
    const sentinel = { get id(): string { throw new Error("sentinel projected"); } };
    mocks.read.mockResolvedValue([...rows, sentinel]);
    const page = await getDesiredPrinterPage("tenant-a", "agent-a", Buffer.from("previous").toString("base64url"), mocks.read);
    expect(page.items).toEqual(rows);
    expect(Buffer.from(page.nextCursor!, "base64url").toString("utf8")).toBe(rows.at(-1)!.id);
    const options = mocks.read.mock.calls[0][0];
    expect(options.limit).toBe(65);
    const where = new PgDialect().sqlToQuery(options.where);
    expect(where.params).toEqual(["tenant-a", "agent-a", "manager", "previous"]);
    expect(options.orderBy).toHaveLength(1);
  });

  it("caps bytes independently of row count and preserves the first omitted row for the next page", async () => {
    const rows = Array.from({ length: 65 }, (_, i) => row(`printer-${i}`, { address: "x".repeat(16000) }));
    mocks.read.mockResolvedValue(rows);
    const page = await getDesiredPrinterPage("tenant-a", "agent-a", undefined, mocks.read);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(64);
    expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(DESIRED_STATE_PAGE_BYTES);
    expect(Buffer.from(page.nextCursor!, "base64url").toString("utf8")).toBe(page.items.at(-1)!.id);
  });

  it("returns a complete empty/end page", async () => {
    mocks.read.mockResolvedValue([]);
    expect(await getDesiredPrinterPage("tenant-a", "agent-a", undefined, mocks.read)).toEqual({ items: [], nextCursor: null });
  });

  it("rejects a corrupt oversize legacy row instead of falsely completing an empty snapshot", async () => {
    mocks.read.mockResolvedValue([row("huge", { address: "x".repeat(DESIRED_STATE_PAGE_BYTES) })]);
    await expect(getDesiredPrinterPage("tenant-a", "agent-a", undefined, mocks.read)).rejects.toThrow("byte limit");
  });

  it("returns scoped continuation evidence without caching", async () => {
    mocks.read.mockResolvedValue([row("طابعة")]);
    const response = await GET(new Request("http://gateway.test/api/agent/desired-state?after=cHJldmlvdXM", { headers: { authorization: "Bearer scoped" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, agentId: "agent-a", desiredState: [{ id: "طابعة" }], desiredStateNextCursor: null });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(new PgDialect().sqlToQuery(mocks.read.mock.calls[0][0].where).params).toEqual(["tenant-a", "agent-a", "manager", "previous"]);
  });

  it.each(["", "!", "_w", "YQ=="])("refuses malformed continuation %s before query", async cursor => {
    const response = await GET(new Request(`http://gateway.test/api/agent/desired-state?after=${encodeURIComponent(cursor)}`));
    expect(response.status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("refuses missing/revoked Agent authentication before reading configuration", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(new Request("http://gateway.test/api/agent/desired-state"))).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("reports a store failure without a partial success array", async () => {
    mocks.read.mockRejectedValue(new Error("database unavailable"));
    const response = await GET(new Request("http://gateway.test/api/agent/desired-state"));
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("desiredState");
  });
});
