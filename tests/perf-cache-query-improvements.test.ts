import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Regression lock for the DB/cache performance pass (2026-09-21):
 *  1. Console list endpoints (agents, printers, jobs) must reject a too-large
 *     offset instead of scanning without bound.
 *  2. The public plan catalog must be publicly cacheable without leaking the
 *     caller identity into the cache key (auth is not part of the response).
 *  3. The print-job API-key lookup must be served by a tenant-composite index
 *     (legacy single-column api_key_id index is redundant and removed).
 *  4. The "unassigned" jobs filter subqueries must be tenant-fenced so they
 *     use the composite tenant+id indexes instead of full-scanning printers
 *     and agents across every tenant.
 *  5. The cache helper exposes the documented SSA-Vary + stale-while-revalidate
 *     preset for CDN/public reads.
 */

describe("list endpoint bounds (offset guards)", () => {
  it("rejects offsets beyond the console list cap", () => {
    const agentsRoute = readFileSync("src/app/api/agents/route.ts", "utf8");
    expect(agentsRoute).toContain("MAX_AGENTS_OFFSET");
    expect(agentsRoute).toContain("offset must be <=");
    expect(agentsRoute).toContain(".limit(limit)");
    expect(agentsRoute).toContain(".offset(offset)");

    const printersRoute = readFileSync("src/app/api/printers/route.ts", "utf8");
    expect(printersRoute).toContain("MAX_PRINTERS_OFFSET");
    expect(printersRoute).toContain(".limit(limit)");
    expect(printersRoute).toContain(".offset(offset)");

    const jobsRoute = readFileSync("src/app/api/jobs/route.ts", "utf8");
    expect(jobsRoute).toContain("MAX_LIST_OFFSET");
    expect(jobsRoute).toContain("offset must be <=");
  });

  it("keeps the Odoo agents/printers discovery endpoints uncached and SANITIZED", () => {
    // These are Odoo-facing and must stay no-store; the performance pass must
    // not have turned them into public caches.
    const odooAgents = readFileSync("src/app/api/odoo/agents/route.ts", "utf8");
    expect(odooAgents).toContain("Cache-Control");
    expect(odooAgents).toContain("no-store");
    const odooPrinters = readFileSync("src/app/api/odoo/printers/route.ts", "utf8");
    expect(odooPrinters).toContain("Cache-Control");
    expect(odooPrinters).toContain("no-store");
  });
});

describe("public plan catalog caching", () => {
  it("cache-controls only the public (auth-independent) billing plans list", () => {
    const plansRoute = readFileSync("src/app/api/billing/plans/route.ts", "utf8");
    // Public cache with stale-while-revalidate; never a private per-user cache.
    expect(plansRoute).toContain("Cache-Control");
    expect(plansRoute).toContain("PUBLIC_VARY_CACHE_CONTROL");
    expect(plansRoute).not.toContain("private");
    expect(plansRoute).not.toContain('"no-store"');
    // The preset itself must bake in shared-cache revalidation semantics.
    const cacheLib = readFileSync("src/lib/cache.ts", "utf8");
    expect(cacheLib).toContain("stale-while-revalidate");
    expect(cacheLib).toContain("s-maxage");
  });
});

describe("print_jobs api-key index consolidation", () => {
  it("replaces the single-column api_key_id index with a tenant composite", () => {
    const schema = readFileSync("src/db/schema.ts", "utf8");
    expect(schema).toContain("print_jobs_tenant_api_key_idx");
    expect(schema).toContain('index("print_jobs_tenant_api_key_idx").on(table.tenantId, table.apiKeyId)');
    expect(schema).not.toContain("print_jobs_api_key_id_idx");
    const migration = readFileSync("drizzle/0057_api_key_composite_index.sql", "utf8");
    expect(migration).toContain('DROP INDEX IF EXISTS "print_jobs_api_key_id_idx"');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "print_jobs_tenant_api_key_idx"');
    const journal = readFileSync("drizzle/meta/_journal.json", "utf8");
    expect(journal).toContain("0057_api_key_composite_index");
  });
});

describe("tenant-fenced unassigned subqueries", () => {
  it("fences NOT IN subqueries by tenant_id so they hit composite indexes", () => {
    const jobsRoute = readFileSync("src/app/api/jobs/route.ts", "utf8");
    expect(jobsRoute).toContain("SELECT id FROM printers WHERE tenant_id = ");
    expect(jobsRoute).toContain("SELECT id FROM agents WHERE tenant_id = ");
  });
});

describe("cache helper presets", () => {
  it("exposes stale-while-revalidate and SSA-Vary for public reads", () => {
    const helper = readFileSync("src/lib/cache.ts", "utf8");
    expect(helper).toContain("SSA-Vary");
    expect(helper).toContain("stale-while-revalidate");
  });
});
