import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("deep production review contracts", () => {
  it("keeps time-bound retry responses on the database clock", () => {
    const reprint = read("src/app/api/jobs/[id]/reprint/route.ts");
    expect(reprint).toContain("databaseNowMs");
    expect(reprint).not.toMatch(/periodEnd\.getTime\(\) - Date\.now\(\)/);
  });

  it("uses PostgreSQL epoch time for shared authentication rate-limit state", () => {
    const source = read("src/lib/auth-rate-limit.ts");
    expect((source.match(/SELECT EXTRACT\(EPOCH FROM clock_timestamp\(\)\) \* 1000 AS now_ms/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("clock_timestamp() - interval '24 hours'");
    expect(source).toContain("Database clock is unavailable");
    expect(source).not.toMatch(/function reserveBucketAttempt[\s\S]{0,700}const now = new Date\(\)/);
    expect(source).not.toMatch(/function reserveAuthAttempt[\s\S]{0,900}const now = new Date\(\)/);
  });

  it("uses the calibrated Gateway clock for Odoo API-key rotation grace", () => {
    const source = read("src/lib/odoo-auth.ts");
    expect(source).toContain('import { gatewayNow } from "./database-clock";');
    expect(source).toContain("const now = gatewayNow()");
    expect(source).not.toContain("const now = new Date()");
  });

  it("keeps Odoo configuration and billing-operation timestamps on PostgreSQL", () => {
    const configuration = read("src/app/api/odoo/configuration/route.ts");
    const billing = read("src/lib/billing-operation.ts");
    expect(configuration).toContain("odooEnabledUpdatedAt: sql`clock_timestamp()`");
    expect(configuration).not.toContain("const now = new Date()");
    expect(billing).toContain("updatedAt: sql`clock_timestamp()`");
    expect(billing).not.toContain("updatedAt: new Date()");
  });

  it("uses database epoch time when re-enabling an Agent and minting its pairing expiry", () => {
    const source = read("src/lib/agent-lifecycle.ts");
    expect(source).toContain("SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms");
    expect(source).toContain("pairingCodeExpiresAt: pairingCode ? new Date(now.getTime() + 10 * 60 * 1000)");
    expect(source).not.toContain("const now = new Date()");
  });

  it("uses monotonic clocks for in-process WebSocket rate limiting", () => {
    const source = read("src/server/ws.ts");
    const upgradeSource = read("src/lib/ws-rate-limit.ts");
    expect(source).toContain('import { performance } from "node:perf_hooks";');
    expect(source).toContain("private lastRefillMs = performance.now()");
    expect(source).toContain("const now = performance.now();");
    expect(source).toContain("const now = performance.now();");
    expect(source).toContain("function pruneIdleWsBuckets(nowMs = performance.now())");
    expect(upgradeSource).toContain('import { performance } from "node:perf_hooks";');
    expect(upgradeSource).toContain("now = performance.now()");
    expect(upgradeSource).toContain("SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms");
    expect(upgradeSource).not.toMatch(/reserveWsUpgradeAttempt[\s\S]{0,700}const now = new Date\(\)/);
  });

  it("submits explicit Odoo retries only after their durable row commits", () => {
    const source = read("odoo_addons/print_gateway/models/print_job.py");
    const retryStart = source.indexOf("    def action_retry(self):");
    const forceStart = source.indexOf("    def action_force_reprint(self):");
    const cronStart = source.indexOf("    def _require_cron_runner(self):");
    expect(retryStart).toBeGreaterThanOrEqual(0);
    expect(forceStart).toBeGreaterThan(retryStart);
    expect(cronStart).toBeGreaterThan(forceStart);

    const retrySection = source.slice(retryStart, forceStart);
    const forceSection = source.slice(forceStart, cronStart);
    expect(retrySection).toContain("self._schedule_postcommit_submission(retry.id)");
    expect(forceSection).toContain("self._schedule_postcommit_submission(retry.id)");
    expect(retrySection).not.toContain("_print_gateway_submission_precommit");
    expect(forceSection).not.toContain("_print_gateway_submission_precommit");
    expect(source).toContain("def _schedule_postcommit_submission(self, job_id):");
    expect(source).toContain("the durable outbox row remains queued for cron recovery");
  });
});
