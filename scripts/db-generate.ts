import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type MigrationJournal = { entries?: Array<{ tag?: string }> };

const journal = JSON.parse(
  readFileSync(resolve(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
) as MigrationJournal;

const latestTag = journal.entries?.at(-1)?.tag;
if (!latestTag) {
  throw new Error("Cannot generate a migration: the Drizzle migration journal is empty.");
}

const snapshotPath = resolve(process.cwd(), "drizzle/meta", latestTag + "_snapshot.json");
if (!existsSync(snapshotPath)) {
  throw new Error(
    "Refusing to run drizzle-kit generate: the canonical snapshot " +
      latestTag +
      "_snapshot.json is missing. Restore the latest snapshot before generating a migration.",
  );
}

const command = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(command, ["drizzle-kit", "generate", ...process.argv.slice(2)], {
  stdio: "inherit",
});
