import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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
  });
});
