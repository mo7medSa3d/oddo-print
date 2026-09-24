import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { sql } from "drizzle-orm";
import { plans, tenantSubscriptions, tenants } from "../src/db/schema";
import { TenantEntitlementConfigError, TenantSubscriptionRequiredError, getTenantEntitlementLimit, liveTenantSubscriptionPredicate } from "../src/lib/entitlements";
import { applyMigrations, closePool, hasTestDatabase, truncateAll } from "./helpers/pg";
import { nanoid } from "../src/lib/nanoid";

const suite = describe.skipIf(!hasTestDatabase);

suite("billing entitlement access policy", () => {
  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await closePool(); });

  it("keeps entitlements available during past_due recovery even after the nominal period end", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Past Due Tenant" });
    await db.insert(plans).values({
      id: planId,
      name: "Past Due Plan",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
      stripePriceId: `price_${nanoid(8)}`,
      currency: "usd",
      interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId,
      planId,
      status: "past_due",
      currentPeriodEnd: new Date(Date.now() - 60_000),
    });

    await expect(getTenantEntitlementLimit(db, tenantId, "max_printers")).resolves.toBe(5);
  });

  it("builds the live-subscription predicate as a reusable correlated expression", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Correlated Predicate Tenant" });
    await db.insert(plans).values({
      id: planId,
      name: "Correlated Predicate Plan",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
      stripePriceId: `price_${nanoid(8)}`,
      currency: "usd",
      interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId,
      planId,
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });

    const result = await db.execute(sql`
      SELECT 1 AS live
      FROM tenants t
      WHERE t.id = ${tenantId}
        AND ${liveTenantSubscriptionPredicate(sql`t.id`)}
      LIMIT 1
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.live).toBe(1);
  });

  it("fails closed for unpaid subscriptions", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Unpaid Tenant" });
    await db.insert(plans).values({
      id: planId,
      name: "Unpaid Plan",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
      stripePriceId: `price_${nanoid(8)}`,
      currency: "usd",
      interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId,
      planId,
      status: "unpaid",
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });

    await expect(getTenantEntitlementLimit(db, tenantId, "max_printers"))
      .rejects.toBeInstanceOf(TenantSubscriptionRequiredError);
  });

  it("fails closed when billing configuration explicitly blocks entitlements", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Blocked Billing Tenant" });
    await db.insert(plans).values({
      id: planId,
      name: "Blocked Billing Plan",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
      stripePriceId: `price_${nanoid(8)}`,
      currency: "usd",
      interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId,
      planId,
      status: "active",
      entitlementBlocked: true,
      entitlementBlockedReason: "stripe_price_unmapped:price_unknown",
    });

    await expect(getTenantEntitlementLimit(db, tenantId, "max_printers"))
      .rejects.toBeInstanceOf(TenantEntitlementConfigError);
  });

  it("fails closed for paused subscriptions", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Paused Tenant" });
    await db.insert(plans).values({
      id: planId,
      name: "Paused Plan",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
      stripePriceId: `price_${nanoid(8)}`,
      currency: "usd",
      interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId,
      planId,
      status: "paused",
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });

    await expect(getTenantEntitlementLimit(db, tenantId, "max_printers"))
      .rejects.toBeInstanceOf(TenantSubscriptionRequiredError);
  });
});
