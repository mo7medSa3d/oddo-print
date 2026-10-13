import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("Drizzle Migration Journal & File Integrity", () => {
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
  // drizzle-kit computes the next migration by diffing src/db/schema.ts against
  // the NEWEST snapshot in drizzle/meta. Without a current snapshot, db:generate
  // can re-emit already-applied DDL instead of producing only the real delta.
  it("keeps a drizzle-kit snapshot for the newest migration", () => {
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

    expect(schemaTables.size).toBeGreaterThan(0);
    expect(snapshotTables).toEqual(schemaTables);
    // The simulation outbox is a distinct tenant/Agent-scoped table, NOT a
    // physical printer or a print job. Its claim and privacy limits must be
    // represented in the latest schema snapshot for future drizzle-kit diffs.
    const capture = snapshot.tables?.["public.e2e_capture_runs"] as
      | { columns?: Record<string, unknown>; foreignKeys?: Record<string, unknown>;
          indexes?: Record<string, unknown>; checkConstraints?: Record<string, unknown> }
      | undefined;
    expect(capture?.columns).toHaveProperty("payload_json");
    expect(capture?.columns).not.toHaveProperty("printer_id");
    expect(capture?.foreignKeys).toHaveProperty("e2e_capture_runs_tenant_agent_fk");
    expect(capture?.indexes).toHaveProperty("e2e_capture_runs_agent_claim_idx");
    expect(capture?.indexes).toHaveProperty("e2e_capture_runs_retention_idx");
    expect(capture?.checkConstraints).toHaveProperty("e2e_capture_runs_finished_payload_check");
    // Version 0081 tightens the actual printers CHECK to physical-only. A
    // snapshot that still advertises virtual printers will cause drizzle-kit
    // to emit misleading follow-up migrations.
    const printersSnapshot = snapshot.tables?.["public.printers"] as
      | { checkConstraints?: { printers_type_check?: { value?: string } } }
      | undefined;
    const typeCheck = printersSnapshot?.checkConstraints?.printers_type_check?.value ?? "";
    expect(typeCheck).toContain(`"printers"."printer_type" = 'physical'`);
    expect(typeCheck).not.toContain("in ('physical','virtual','redirected')");
  });
});
