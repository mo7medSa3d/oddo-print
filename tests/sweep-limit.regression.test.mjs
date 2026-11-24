import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("cloud job maintenance sweeper is retired and print_jobs tables/triggers are absent", () => {
  assert.equal(existsSync("src/lib/job-maintenance.ts"), false);
  const sql = readFileSync("drizzle/0000_initial_schema.sql", "utf8");
  assert.doesNotMatch(sql, /CREATE TABLE "print_jobs"/);
  assert.doesNotMatch(sql, /CREATE TABLE "job_events"/);
  assert.doesNotMatch(sql, /ON print_jobs/);
});
