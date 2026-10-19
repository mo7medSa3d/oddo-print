import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { printJobs } from "../src/db/schema";
import { db } from "../src/db";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("AUDIT-01: Tenant Isolation in Batch Materialization Queries", () => {
  it("enforces tenant-scoped predicate on batch select in jobs/route.ts", () => {
    const code = read("src/app/api/jobs/route.ts");
    // Ensure the batch query explicitly combines tenantId and inArray
    expect(code).toMatch(/tx\.select\(\)\.from\(printJobs\)\.where\(\s*and\(\s*eq\(printJobs\.tenantId,\s*claims\.tenantId\),\s*inArray\(printJobs\.id,\s*batchIds\)\s*\)\)/);
  });

  it("enforces tenant-scoped predicate on batch select in actions.ts deleteAgent", () => {
    const code = read("src/app/actions.ts");
    // Ensure the batch query explicitly combines tenantId and inArray
    expect(code).toMatch(/tx\.select\(\)\.from\(printJobs\)\.where\(\s*and\(\s*eq\(printJobs\.tenantId,\s*manager\.tenantId\),\s*inArray\(printJobs\.id,\s*batchIds\)\s*\)\)/);
  });

  it("generates SQL with tenant_id filter for batch queries", () => {
    const query = db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.tenantId, "tenant_a"), inArray(printJobs.id, ["job_1", "job_2"])))
      .toSQL();

    expect(query.sql).toContain('"print_jobs"."tenant_id" = $1');
    expect(query.sql).toContain('"print_jobs"."id" in ($2, $3)');
    expect(query.params).toEqual(["tenant_a", "job_1", "job_2"]);
  });
});
