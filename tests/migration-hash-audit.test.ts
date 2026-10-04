import { describe, it, expect } from "vitest";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { PoolClient } from "pg";
import { migrateByHash, AUDIT_REPAIRS } from "../scripts/db-migrate";

describe("migration hash recovery", () => {
  it("recovers timestamp-regressed holes once and keeps journal order", async () => {
    const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
    const holes = new Set([33, 34, 35, 36, 74]);
    const hashes = new Set(migrations.filter((_, i) => !holes.has(i)).map(m => m.hash));
    const calls: string[] = [];
    const client = { query: async (query: string, values?: unknown[]) => {
      calls.push(query);
      if (query === "SELECT hash FROM drizzle.__drizzle_migrations") return { rows: [...hashes].map(hash => ({ hash })) };
      if (query.startsWith("INSERT INTO drizzle.__drizzle_migrations")) hashes.add(String(values![0]));
      return { rows: [] };
    } } as unknown as PoolClient;
    await migrateByHash(client, "./drizzle");
    const statements = [...holes].flatMap(i => migrations[i].sql.filter(s => s.trim()));
    expect(calls.filter(s => statements.includes(s))).toEqual(statements);
    expect(calls.filter(s => s.startsWith("INSERT INTO drizzle.__drizzle_migrations"))).toHaveLength(holes.size + AUDIT_REPAIRS.length);
    calls.length = 0;
    await migrateByHash(client, "./drizzle");
    expect(calls.some(s => s.startsWith("INSERT INTO drizzle.__drizzle_migrations"))).toBe(false);
    expect(calls).not.toContain(statements[0]);
    expect(calls.at(-1)).toBe("COMMIT");
  });
});
