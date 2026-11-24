import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { PoolClient } from "pg";
import { migrateByHash, AUDIT_REPAIRS, scopeMigrationConstraintGuards } from "../scripts/db-migrate";

function mockClient(hashes: Set<string>, calls: string[]): PoolClient {
  return {
    query: async (query: string, values?: unknown[]) => {
      calls.push(query);
      if (query === "SELECT hash FROM drizzle.__drizzle_migrations") {
        return { rows: [...hashes].map(hash => ({ hash })) };
      }
      if (query.startsWith("INSERT INTO drizzle.__drizzle_migrations")) {
        hashes.add(String(values![0]));
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
}

describe("migration hash recovery", () => {
  it("recovers timestamp-regressed holes once and keeps journal order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "odoo-print-hash-audit-"));
    try {
      await mkdir(join(dir, "meta"), { recursive: true });
      await writeFile(join(dir, "0000_base.sql"), "CREATE TABLE t_base (id text PRIMARY KEY);");
      await writeFile(
        join(dir, "0001_hole.sql"),
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't_base_id_check') THEN NULL; END IF; END $$;",
      );
      await writeFile(join(dir, "0002_later.sql"), "CREATE TABLE t_later (id text PRIMARY KEY);");
      await writeFile(
        join(dir, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            { idx: 0, version: "7", when: 1700000000000, tag: "0000_base", breakpoints: true },
            { idx: 1, version: "7", when: 1699999999000, tag: "0001_hole", breakpoints: true },
            { idx: 2, version: "7", when: 1700000002000, tag: "0002_later", breakpoints: true },
          ],
        }),
      );

      const migrations = readMigrationFiles({ migrationsFolder: dir });
      const holes = new Set([1]);
      const hashes = new Set(migrations.filter((_, i) => !holes.has(i)).map(m => m.hash));
      const calls: string[] = [];
      const client = mockClient(hashes, calls);

      await migrateByHash(client, dir);
      const statements = [...holes].flatMap(i =>
        migrations[i].sql.filter(s => s.trim()).map(scopeMigrationConstraintGuards),
      );
      expect(statements.some(s => s.includes("connamespace = (SELECT oid FROM pg_namespace"))).toBe(true);
      expect(calls.filter(s => statements.includes(s))).toEqual(statements);
      expect(calls.filter(s => s.startsWith("INSERT INTO drizzle.__drizzle_migrations"))).toHaveLength(
        holes.size + AUDIT_REPAIRS.length,
      );

      calls.length = 0;
      await migrateByHash(client, dir);
      expect(calls.some(s => s.startsWith("INSERT INTO drizzle.__drizzle_migrations"))).toBe(false);
      expect(calls).not.toContain(statements[0]);
      expect(calls.at(-1)).toBe("COMMIT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies the clean ./drizzle baseline once and is idempotent on replay", async () => {
    const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    const hashes = new Set<string>();
    const calls: string[] = [];
    const client = mockClient(hashes, calls);

    await migrateByHash(client, "./drizzle");
    expect(calls.filter(s => s.startsWith("INSERT INTO drizzle.__drizzle_migrations"))).toHaveLength(
      migrations.length + AUDIT_REPAIRS.length,
    );

    calls.length = 0;
    await migrateByHash(client, "./drizzle");
    expect(calls.some(s => s.startsWith("INSERT INTO drizzle.__drizzle_migrations"))).toBe(false);
    expect(calls.at(-1)).toBe("COMMIT");
  });
});
