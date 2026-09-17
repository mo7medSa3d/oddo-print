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
});
