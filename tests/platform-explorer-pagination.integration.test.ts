import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { readPlatformDatabase } from "../src/lib/platform-data-explorer";
import { applyMigrations, closePool, hasTestDatabase, pool } from "./helpers/pg";

const read = (input: { table?: string; search?: string; offset?: number }) =>
  db.transaction(tx => readPlatformDatabase(tx, input));

describe.skipIf(!hasTestDatabase)("database explorer pagination on PostgreSQL", () => {
  beforeAll(async () => {
    await applyMigrations();
    await pool().query(`CREATE TABLE explorer_page_fixture (
      name text NOT NULL, code text NOT NULL, created_at timestamp NOT NULL,
      secret_hash text, payload jsonb, PRIMARY KEY(name,code)
    )`);
    await pool().query(`INSERT INTO explorer_page_fixture
      SELECT 'Same visible name',lpad(n::text,2,'0'),'2026-01-01'::timestamp,
             'sensitive-fixture','{"private":"document-fixture"}'::jsonb
      FROM generate_series(0,49) n`);
  });
  afterAll(async () => { await pool().query("DROP TABLE IF EXISTS explorer_page_fixture"); await closePool(); });

  it("returns stable non-overlapping pages through timestamp and primary-key ties", async () => {
    const first = await read({ table: "explorer_page_fixture" });
    const last = await read({ table: "explorer_page_fixture",offset: 25 });
    expect(first.rows).toHaveLength(25);
    expect(last.rows).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    expect(last.hasMore).toBe(false);
    expect([...first.rows,...last.rows].map(row => row.code)).toEqual(Array.from({ length: 50 },(_,n) => String(49-n).padStart(2,"0")));
    expect(first.columns).toEqual(["name","code","created_at"]);
    expect(JSON.stringify(first)).not.toContain("sensitive-fixture");
    expect(JSON.stringify(first)).not.toContain("document-fixture");
    expect(first.tables.find(table => table.name === "explorer_page_fixture")?.primaryKeys).toEqual(["name","code"]);
  });

  it("binds search punctuation and rejects arbitrary table identifiers", async () => {
    const injection = "x'; DROP TABLE explorer_page_fixture;--";
    expect((await read({ table: "explorer_page_fixture",search: injection })).rows).toEqual([]);
    expect((await read({ table: injection })).selected).toBeNull();
    expect(Number((await pool().query("SELECT count(*) AS n FROM explorer_page_fixture")).rows[0].n)).toBe(50);
  });
});
