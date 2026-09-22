import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { createPrintJobForPrinter } from "../src/lib/print-job-service";
import { TenantPrintQuotaExceededError, getTenantPrintUsage } from "../src/lib/entitlements";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

function payload(label: string) {
  return { type: "raw", protocol: "raw", encoding: "base64", data: Buffer.from(label, "utf8").toString("base64") };
}

suite("tenant print quota", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => { await truncateAll(); });

  async function setPlanLimit(tenantId: string, limit: number | "unlimited") {
    const entitlements = { max_agents: "unlimited", max_printers: "unlimited", max_jobs_per_minute: "unlimited", max_concurrent_jobs: "unlimited", max_prints_per_period: limit };
    await pool().query(`UPDATE plans SET entitlements = $1::jsonb WHERE id = (SELECT plan_id FROM tenant_subscriptions WHERE tenant_id = $2)`, [JSON.stringify(entitlements), tenantId]);
  }

  it("enforces a finite print quota before the job row is inserted", async () => {
    const f = await seedFixture();
    await setPlanLimit(f.tenantId, 20);

    for (let i = 1; i <= 20; i += 1) {
      const result = await createPrintJobForPrinter(f.printerId, payload(`quota-${i}`), {
        tenantId: f.tenantId, requestedBy: "quota-test", documentType: "receipt", destination: f.destination,
        idempotencyKey: `quota-${i}`, expiresAt: new Date(Date.now() + 60_000),
      });
      expect(result.isReused).toBe(false);
    }

    await expect(createPrintJobForPrinter(f.printerId, payload("quota-21"), {
      tenantId: f.tenantId, requestedBy: "quota-test", documentType: "receipt", destination: f.destination,
      idempotencyKey: "quota-21", expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toBeInstanceOf(TenantPrintQuotaExceededError);

    const usage = await getTenantPrintUsage(db, f.tenantId);
    expect(usage.limit).toBe(20);
    expect(usage.used).toBe(20);
    expect(usage.remaining).toBe(0);
    expect(Number((await pool().query("SELECT count(*)::int AS n FROM print_jobs WHERE tenant_id = $1", [f.tenantId])).rows[0].n)).toBe(20);
  });

  it("does not double-consume a print credit when an idempotent retry reuses the same job", async () => {
    const f = await seedFixture();
    await setPlanLimit(f.tenantId, 20);
    const options = {
      tenantId: f.tenantId, requestedBy: "quota-test", documentType: "receipt", destination: f.destination,
      idempotencyKey: "quota-idempotent", expiresAt: new Date(Date.now() + 60_000),
    } as const;
    const first = await createPrintJobForPrinter(f.printerId, payload("same-print"), options);
    const second = await createPrintJobForPrinter(f.printerId, payload("same-print"), options);
    expect(second.isReused).toBe(true);
    expect(second.id).toBe(first.id);
    const usage = await getTenantPrintUsage({ execute: (query) => pool().query(query) as never }, f.tenantId);
    expect(usage.used).toBe(1);
  });

  it("serializes concurrent admissions so the quota cannot be overshot", async () => {
    const f = await seedFixture();
    await setPlanLimit(f.tenantId, 5);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => createPrintJobForPrinter(f.printerId, payload(`parallel-${i}`), {
      tenantId: f.tenantId, requestedBy: "quota-test", documentType: "receipt", destination: f.destination,
      idempotencyKey: `parallel-${i}`, expiresAt: new Date(Date.now() + 60_000),
    })));
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(15);
    expect(rejected.every((r) => r.reason instanceof TenantPrintQuotaExceededError)).toBe(true);
    const usage = await getTenantPrintUsage({ execute: (query) => pool().query(query) as never }, f.tenantId);
    expect(usage.used).toBe(5);
  });

  it("starts a new quota bucket when Stripe advances the subscription period", async () => {
    const f = await seedFixture();
    await setPlanLimit(f.tenantId, 2);
    const firstStart = new Date(Date.now() - 60_000);
    const firstEnd = new Date(Date.now() + 60_000);
    await pool().query("UPDATE tenant_subscriptions SET current_period_start = $1, current_period_end = $2 WHERE tenant_id = $3", [firstStart, firstEnd, f.tenantId]);
    await createPrintJobForPrinter(f.printerId, payload("period-1"), { tenantId: f.tenantId, requestedBy: "quota-test", documentType: "receipt", destination: f.destination, idempotencyKey: "period-1" });

    const nextStart = new Date(Date.now() + 120_000);
    const nextEnd = new Date(Date.now() + 181_000);
    await pool().query("UPDATE tenant_subscriptions SET current_period_start = $1, current_period_end = $2 WHERE tenant_id = $3", [nextStart, nextEnd, f.tenantId]);
    await createPrintJobForPrinter(f.printerId, payload("period-2"), { tenantId: f.tenantId, requestedBy: "quota-test", documentType: "receipt", destination: f.destination, idempotencyKey: "period-2" });

    const rows = await pool().query("SELECT period_start, used_prints FROM print_usage_periods WHERE tenant_id = $1 ORDER BY period_start", [f.tenantId]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r: { used_prints: number }) => Number(r.used_prints))).toEqual([1, 1]);
  });
});