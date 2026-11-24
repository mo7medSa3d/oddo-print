import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DbTx } from "../src/db";
import { exploreRows, listExploreTables, readPlatformDatabase } from "../src/lib/platform-data-explorer";

const dialect = new PgDialect();
const transaction = (execute: ReturnType<typeof vi.fn>) => ({ execute }) as unknown as DbTx;
const render = (statement: SQL) => dialect.sqlToQuery(statement);
const catalog = [
  { table_name: "printers", column_name: "id", data_type: "text", is_primary: true },
  { table_name: "printers", column_name: "name", data_type: "text", is_primary: false },
  { table_name: "printers", column_name: "secret_hash", data_type: "text", is_primary: false },
  { table_name: "printers", column_name: "payload", data_type: "jsonb", is_primary: false },
  { table_name: "refresh_tokens", column_name: "id", data_type: "text", is_primary: true },
  ...["platform_session_security", "workspace_session_security"]
    .map(table_name => ({ table_name, column_name: "id", data_type: "text", is_primary: true })),
];

describe("read-only Platform Owner catalog and search", () => {
  it("reads one bounded catalog and strips secrets and auth tables", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: catalog });
    const result = await listExploreTables(transaction(execute));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(render(execute.mock.calls[0][0]).sql).toContain("LIMIT 250");
    expect(result).toEqual([{ name: "printers", columns: ["id", "name"], primaryKey: "id" }]);
  });

  it("excludes retired billing columns and tables before and after migration", async () => {
    const fixtures = [
      { table_name: "plans", column_name: "id", data_type: "text", is_primary: true },
      { table_name: "plans", column_name: "name", data_type: "text", is_primary: false },
      { table_name: "plans", column_name: "stripe_price_id", data_type: "text", is_primary: false },
      { table_name: "plans", column_name: "stripe_product_id", data_type: "text", is_primary: false },
      { table_name: "plans", column_name: "display_order", data_type: "integer", is_primary: false },
      { table_name: "tenant_subscriptions", column_name: "tenant_id", data_type: "text", is_primary: true },
      { table_name: "tenant_subscriptions", column_name: "checkout_status", data_type: "text", is_primary: false },
      { table_name: "tenant_subscriptions", column_name: "status", data_type: "text", is_primary: false },
      { table_name: "billing_events", column_name: "event_id", data_type: "text", is_primary: true },
    ];
    const result = await listExploreTables(transaction(vi.fn().mockResolvedValue({ rows: fixtures })));
    expect(result).toEqual([
      { name: "plans", columns: ["id", "name"], primaryKey: "id" },
      { name: "tenant_subscriptions", columns: ["tenant_id", "status"], primaryKey: "tenant_id" },
    ]);
  });

  it("binds literal punctuation and never interpolates search input", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ id: "A1", name: "Desk" }] });
    const term = `_%'";DROP TABLE printers;--`;
    await exploreRows(transaction(execute), { name: "printers", columns: ["id", "name"], primaryKey: "id" }, term, 25, 25);
    const query = render(execute.mock.calls[0][0]);
    expect(query.sql).toContain('FROM "printers"');
    expect(query.sql).toContain('strpos(lower("name"::text), lower($2)) > 0');
    expect(query.sql).not.toContain("DROP TABLE");
    expect(query.params).toEqual([term, term, 25, 25]);
  });

  it("sets a bounded timeout and uses the caller-owned transaction", async () => {
    const execute = vi.fn(async (statement: SQL) => {
      const query = render(statement);
      if (query.sql.includes("information_schema.columns")) return { rows: catalog };
      if (query.sql.includes('FROM "printers"')) return { rows: [{ id: "A1", name: "Desk" }] };
      return { rows: [] };
    });
    const result = await readPlatformDatabase(transaction(execute), { table: "printers", search: "desk" });
    expect(result.selected).toBe("printers");
    expect(result.rows).toHaveLength(1);
    const statements = execute.mock.calls.map(([statement]) => render(statement).sql);
    expect(statements[0]).toContain("statement_timeout = '4000ms'");
    expect(statements[1]).toContain("information_schema.columns");
    expect(statements[2]).toContain('FROM "printers"');
  });

  it("propagates query failures to the caller-owned transaction", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: catalog })
      .mockRejectedValueOnce(new Error("database unavailable"));
    await expect(readPlatformDatabase(transaction(execute), { table: "printers" })).rejects.toThrow("database unavailable");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each([0, 24, 25, 26])("reports pagination from an extra row, with %i available rows", async (count) => {
    const rows = Array.from({ length: count }, (_, i) => ({ id: `printer_${i}`, name: `Printer ${i}` }));
    const execute = vi.fn(async (statement: SQL) => {
      const query = render(statement);
      if (query.sql.includes("information_schema.columns")) return { rows: catalog };
      if (query.sql.includes('FROM "printers"')) return { rows: rows.slice(0, Number(query.params[0])) };
      return { rows: [] };
    });
    const result = await readPlatformDatabase(transaction(execute), { table: "printers" });
    expect(result.rows).toEqual(rows.slice(0, 25));
    expect(result.hasMore).toBe(count > 25);
  });

  it("uses the primary key to break ties in creation timestamps", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await exploreRows(transaction(execute), {
      name: "printers", columns: ["id", "name", "created_at"], primaryKey: "id",
    }, "", 25, 26);
    expect(render(execute.mock.calls[0][0]).sql).toContain('ORDER BY "created_at" DESC, "id" DESC');
  });
});
