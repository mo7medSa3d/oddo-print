import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { createPrintJobForPrinter } from "../src/lib/print-job-service";
import { getTenantPrintUsage, reserveTenantPrintCredit } from "../src/lib/entitlements";
import {
  __setClockSkewForTests,
  clockSkewMs,
  databaseNowMs,
  gatewayNowMs,
  isClockCalibrated,
  refreshClockSkew,
} from "../src/lib/database-clock";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

function payload(label: string) {
  return { type: "raw", protocol: "raw", encoding: "base64", data: Buffer.from(label, "utf8").toString("base64") };
}

suite("gateway clock authority against PostgreSQL", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { __setClockSkewForTests(null); await closePool(); });
  beforeEach(async () => { await truncateAll(); __setClockSkewForTests(null); });

  it("calibrates the JS clock from the database clock within the round-trip budget", async () => {
    const measured = await refreshClockSkew(true);
    expect(isClockCalibrated()).toBe(true);
    expect(Number.isFinite(measured ?? NaN)).toBe(true);
    const databaseMs = await databaseNowMs();
    expect(Math.abs(gatewayNowMs() - databaseMs)).toBeLessThan(2_000);
    expect(clockSkewMs()).toBe(measured);
  });

  it("stamps created_at and expires_at from one clock reading", async () => {
    const f = await seedFixture();
    const job = await createPrintJobForPrinter(f.printerId, payload("ttl"), {
      tenantId: f.tenantId,
      requestedBy: "clock-test",
      documentType: "receipt",
      destination: f.destination,
      idempotencyKey: "clock-ttl",
    });

    const row = (await pool().query(
      "SELECT extract(epoch FROM (expires_at - created_at))::float8 AS ttl, extract(epoch FROM (updated_at - created_at))::float8 AS updated_delta FROM print_jobs WHERE id = $1",
      [job.id],
    )).rows[0] as { ttl: number; updated_delta: number };

    // Default TTL is one hour, and both columns come from the same
    // clock_timestamp() read: any drift (for example created_at falling back to
    // the transaction-start default now()) shows up here immediately.
    expect(row.ttl).toBe(3600);
    expect(row.updated_delta).toBe(0);
  });

  it("keeps the print_jobs column defaults on the wall clock", async () => {
    const defaults = await pool().query(
      `SELECT a.attname AS column,
              pg_get_expr(d.adbin, d.adrelid) AS default_expression
         FROM pg_attribute a
         JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'print_jobs'::regclass
          AND a.attname IN ('created_at', 'updated_at')
        ORDER BY a.attname`,
    );
    expect(defaults.rows.map((r: { default_expression: string }) => r.default_expression)).toEqual([
      "clock_timestamp()",
      "clock_timestamp()",
    ]);
  });

  it("rolls the print credit back with the enqueue transaction", async () => {
    const f = await seedFixture();
    const limit = 5;
    await pool().query(
      "UPDATE plans SET entitlements = jsonb_set(entitlements, '{max_prints_per_period}', to_jsonb($2::int)) WHERE id = (SELECT plan_id FROM tenant_subscriptions WHERE tenant_id = $1)",
      [f.tenantId, limit],
    );

    // Reserve a credit inside a transaction that then fails: the credit must
    // disappear with the transaction, otherwise a failed INSERT would bill the
    // tenant for a job that does not exist.
    await expect(
      db.transaction(async (tx) => {
        await reserveTenantPrintCredit(tx, f.tenantId);
        throw new Error("enqueue failed after reserving the credit");
      }),
    ).rejects.toThrow("enqueue failed");

    expect(Number((await pool().query("SELECT COALESCE(SUM(used_prints), 0)::int AS n FROM print_usage_periods WHERE tenant_id = $1", [f.tenantId])).rows[0].n)).toBe(0);

    const usage = await getTenantPrintUsage(db, f.tenantId);
    expect(usage.used).toBe(0);
    expect(usage.remaining).toBe(limit);
    expect(Number((await pool().query("SELECT count(*)::int AS n FROM print_jobs WHERE tenant_id = $1", [f.tenantId])).rows[0].n)).toBe(0);
  });

  it("never stores more used credits than the plan limit", async () => {
    const f = await seedFixture();
    await pool().query(
      "UPDATE plans SET entitlements = jsonb_set(entitlements, '{max_prints_per_period}', to_jsonb(3::int)) WHERE id = (SELECT plan_id FROM tenant_subscriptions WHERE tenant_id = $1)",
      [f.tenantId],
    );
    for (let i = 0; i < 3; i += 1) {
      await createPrintJobForPrinter(f.printerId, payload(`cap-${i}`), {
        tenantId: f.tenantId, requestedBy: "clock-test", documentType: "receipt", destination: f.destination, idempotencyKey: `cap-${i}`,
      });
    }
    // Extra attempts (idempotent replay of an existing key, then a fresh key)
    await createPrintJobForPrinter(f.printerId, payload("cap-0"), {
      tenantId: f.tenantId, requestedBy: "clock-test", documentType: "receipt", destination: f.destination, idempotencyKey: "cap-0",
    });
    await expect(createPrintJobForPrinter(f.printerId, payload("cap-4"), {
      tenantId: f.tenantId, requestedBy: "clock-test", documentType: "receipt", destination: f.destination, idempotencyKey: "cap-4",
    })).rejects.toMatchObject({ code: "PRINT_QUOTA_EXCEEDED" });

    const usage = await getTenantPrintUsage(db, f.tenantId);
    expect(usage.used).toBe(3);
    const stored = await db.execute(sql`SELECT used_prints FROM print_usage_periods WHERE tenant_id = ${f.tenantId}`);
    expect(stored.rows.map((r) => Number((r as { used_prints: number | string }).used_prints))).toEqual([3]);
  });
});
