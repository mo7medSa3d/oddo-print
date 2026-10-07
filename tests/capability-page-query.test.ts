import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const chain = vi.hoisted(() => ({ select: vi.fn(), from: vi.fn(), leftJoin: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn() }));
vi.mock("../src/db/client", () => ({ db: { select: chain.select }, queryWithTimeout: (query: () => Promise<unknown>) => query() }));
import { getPrinterCapabilityPage } from "../src/lib/printer-health";

describe("bounded capability query before projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const method of [chain.select, chain.from, chain.leftJoin, chain.where, chain.orderBy]) method.mockReturnValue(chain);
  });

  it("fetches one bounded sentinel, scopes tenant and cursor, and projects only the requested page", async () => {
    const printerRow = (id: string) => ({ printer: { id, tenantId: "tenant-a", name: id, protocol: "spooler", connectionType: "spooler", status: "unknown", config: {}, capabilities: null }, agent: null });
    // A non-projectable sentinel proves it is discarded before diagnostics.
    chain.limit.mockResolvedValue([printerRow("طبعة-a"), printerRow("طبعة-b"), { printer: null, agent: null }]);
    const page = await getPrinterCapabilityPage("tenant-a", { limit: 2, afterId: "earlier" });
    expect(chain.limit).toHaveBeenCalledWith(3);
    expect(chain.orderBy).toHaveBeenCalledOnce();
    const predicate = new PgDialect().sqlToQuery(chain.where.mock.calls[0][0]);
    expect(predicate.sql).toContain('"printers"."tenant_id" =');
    expect(predicate.sql).toContain('"printers"."id" >');
    expect(predicate.params).toEqual(["tenant-a", "earlier"]);
    expect(page.items.map(item => item.printerId)).toEqual(["طبعة-a", "طبعة-b"]);
    expect(page.hasMore).toBe(true);
    expect(Buffer.from(page.nextCursor!, "base64url").toString("utf8")).toBe("طبعة-b");
  });

  it.each([[undefined, 101], [0, 2], [-4, 2], [5000, 1001]])("bounds internal limit %s", async (limit, fetchLimit) => {
    chain.limit.mockResolvedValue([]);
    const page = await getPrinterCapabilityPage("tenant-a", { limit });
    expect(chain.limit).toHaveBeenCalledWith(fetchLimit);
    expect(page).toEqual({ items: [], hasMore: false });
  });
});
