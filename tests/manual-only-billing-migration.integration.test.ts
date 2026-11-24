import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { applyMigrations, hasTestDatabase, pool, closePool } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);
suite("manual-only billing migration", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  it("removes all obsolete provider columns without removing operational subscription fields", async () => {
    const fields = await pool().query(`SELECT table_name,column_name
      FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name IN ('plans','tenant_subscriptions')
      AND (column_name LIKE 'stripe_%' OR column_name LIKE 'checkout_%'
        OR column_name LIKE 'billing_operation_%'
        OR column_name IN ('billing_mode','currency','interval','trial_started_at'))`);
    expect(fields.rows).toEqual([]);
    const active = await pool().query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='tenant_subscriptions'
      AND column_name IN ('monthly_quota','subscription_type','term','internal_reference','revision')`);
    expect(active.rowCount).toBe(5);
  });
  it.each(["trialing", "past_due", "incomplete", "cancelled", "paused", "unpaid"])(
    "rejects retired provider state %s at the PostgreSQL boundary",
    async (status) => {
      const tenant = `manual_state_guard_${status}`;
      await pool().query("INSERT INTO tenants(id,name) VALUES ($1,'Manual-only validation') ON CONFLICT DO NOTHING", [tenant]);
      const plan = `manual_state_plan_${status}`;
      await pool().query("INSERT INTO plans(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [plan, plan]);
      await expect(pool().query(
        "INSERT INTO tenant_subscriptions(tenant_id,plan_id,status) VALUES ($1,$2,$3)",
        [tenant, plan, status],
      )).rejects.toMatchObject({ code: "23514", constraint: "tenant_subscriptions_status_check" });
    },
  );
  it("omits retired provider billing tables from the clean runtime schema", async () => {
    const result = await pool().query(`SELECT table_schema,table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name IN ('billing_events','print_usage_periods')
      ORDER BY table_name`);
    expect(result.rows).toEqual([]);
  });
});
