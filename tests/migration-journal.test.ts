import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeMigrationConstraintGuards } from "../scripts/db-migrate";

const DROPPED_LEGACY_TABLES = [
  "agents",
  "printers",
  "print_jobs",
  "print_job_receipts",
  "print_monthly_usage",
  "job_events",
  "discovered_devices",
  "discovery_sessions",
  "odoo_v2_operations",
  "odoo_legacy_resolutions",
  "tenant_domains",
];

describe("Drizzle Migration Journal & File Integrity", () => {
  it("scopes legacy constraint guards without changing the original trusted SQL", () => {
    const original = "SELECT 1 FROM pg_constraint WHERE conname = 'agents_tenant_id_unique'";
    const scoped = scopeMigrationConstraintGuards(original);
    expect(scoped).toContain("connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())");
    expect(scoped).toContain("AND conname = 'agents_tenant_id_unique'");
    expect(original).toBe("SELECT 1 FROM pg_constraint WHERE conname = 'agents_tenant_id_unique'");
    expect(scopeMigrationConstraintGuards(scoped)).toBe(scoped);
  });
  it("retains already-scoped and unrelated catalog statements", () => {
    for (const statement of [
      "SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.conname='agents_tenant_id_unique' AND n.nspname=current_schema()",
      "SELECT 1 FROM pg_constraint WHERE connamespace = 42 AND conname = 'agents_tenant_id_unique'",
      "ALTER TABLE agents ADD CONSTRAINT agents_tenant_id_unique UNIQUE(tenant_id,id)",
    ]) expect(scopeMigrationConstraintGuards(statement)).toBe(statement);
  });
  it("enforces exact 1-to-1 match between SQL migration files and _journal.json", () => {
    const drizzleDir = join(process.cwd(), "drizzle");
    const sqlFiles = readdirSync(drizzleDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const journalPath = join(drizzleDir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number; tag: string; version: string; when: number; breakpoints?: boolean }>;
    };

    expect(journal.entries.length).toBe(sqlFiles.length);

    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      const expectedFilename = `${entry.tag}.sql`;
      expect(sqlFiles[i]).toBe(expectedFilename);
    });
  });

  it("keeps a drizzle-kit snapshot matching all 21 schema.ts tables and omitting dropped legacy tables", () => {
    const drizzleDir = join(process.cwd(), "drizzle");
    const journalPath = join(drizzleDir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const newest = journal.entries[journal.entries.length - 1];

    const snapshotPath = join(drizzleDir, "meta", `${newest.tag}_snapshot.json`);
    expect(existsSync(snapshotPath)).toBe(true);

    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      tables?: Record<string, unknown>;
    };
    const snapshotTables = new Set(
      Object.keys(snapshot.tables ?? {}).map((name) =>
        name.includes(".") ? name.split(".").slice(1).join(".") : name,
      ),
    );

    const schemaSource = readFileSync(join(process.cwd(), "src", "db", "schema.ts"), "utf8");
    const schemaTables = new Set(
      [...schemaSource.matchAll(/export const \w+ = pgTable\("([\w_]+)"/g)].map((m) => m[1]),
    );

    expect(schemaTables.size).toBe(21);
    expect(snapshotTables).toEqual(schemaTables);
    expect(snapshot.tables).not.toHaveProperty("public.e2e_capture_runs");
    for (const dropped of DROPPED_LEGACY_TABLES) {
      expect(snapshot.tables).not.toHaveProperty(`public.${dropped}`);
    }
  });

  it("keeps retired capture and Test Center backends out of shipped runtime code", () => {
    const roots = [
      "src", "agent/internal", "src-tauri/src",
      "odoo_addons19/print_gateway/models",
      "odoo_addons19/print_gateway/controllers",
      "odoo_addons19/print_gateway/static/src",
    ];
    const retired = /\be2e_capture_runs\b|\bCaptureTestDocument\b|\bTestCenter\b|\/api\/e2e-capture\b/i;
    let checked = 0;
    const walk = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) { walk(path); continue; }
        if (!item.isFile() || !/\.(?:ts|tsx|js|go|py|rs|xml)$/.test(item.name) ||
            /(?:_test\.go|^test_.*\.py$)/.test(item.name)) continue;
        expect(readFileSync(path, "utf8")).not.toMatch(retired);
        checked += 1;
      }
    };
    for (const root of roots) walk(join(process.cwd(), root));
    expect(readFileSync(join(process.cwd(), "server.ts"), "utf8")).not.toMatch(retired);
    expect(checked).toBeGreaterThan(100);
  });
});
