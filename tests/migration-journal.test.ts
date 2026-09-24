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
  // the NEWEST snapshot in drizzle/meta. If that snapshot is stale, `db:generate`
  // silently re-emits DDL for migrations that are already applied — and when the
  // delta contains column renames it stops on an interactive prompt instead of
  // failing cleanly. Keep a snapshot pinned to the newest journal entry so the
  // next `db:generate` diffs from real HEAD state.
  it("keeps a drizzle-kit snapshot for the newest migration", () => {
    const journalPath = join(process.cwd(), "drizzle", "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const newest = journal.entries[journal.entries.length - 1];

    const snapshotPath = join(process.cwd(), "drizzle", "meta", `${newest.tag}_snapshot.json`);
    expect(existsSync(snapshotPath)).toBe(true);

    // The snapshot must describe the current schema, otherwise it is a lie that
    // makes the next generate produce either empty or destructive DDL.
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
  });
});
