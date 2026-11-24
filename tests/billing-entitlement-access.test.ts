import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { sql } from "drizzle-orm";
import { plans, tenantSubscriptions, tenants } from "../src/db/schema";
import { TenantEntitlementConfigError, TenantSubscriptionRequiredError, getTenantEntitlementLimit, liveTenantSubscriptionPredicate, requireTenantBillingAccess } from "../src/lib/entitlements";
import { effectiveSubscriptionStatusSql } from "../src/lib/effective-subscription-status";
import { applyMigrations, closePool, hasTestDatabase, truncateAll } from "./helpers/pg";
import { nanoid } from "../src/lib/nanoid";

const suite = describe.skipIf(!hasTestDatabase);

suite("billing entitlement access policy", () => {
  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await closePool(); });

  it("requires explicit manual activation before customer provisioning", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Past Due Tenant" });
    await db.insert(plans).values({
      id: planId,
      name: "Past Due Plan",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
    });
    await db.insert(tenantSubscriptions).values({
      tenantId,
      planId,
      status: "awaiting_activation",
      currentPeriodEnd: new Date(Date.now() - 60_000),
    });

    await expect(getTenantEntitlementLimit(db, tenantId, "max_printers")).rejects.toBeInstanceOf(TenantSubscriptionRequiredError);
  });

  it("builds the live-subscription predicate as a reusable correlated expression", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Correlated Predicate Tenant" });
    await db.insert(plans).values({
      id: planId,
      name: "Correlated Predicate Plan",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
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

  it("fails closed for expired subscriptions", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Unpaid Tenant" });
    await db.insert(plans).values({
      id: planId,
      name: "Unpaid Plan",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
    });
    await db.insert(tenantSubscriptions).values({
      tenantId,
      planId,
      status: "expired",
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
    });
    await db.insert(tenantSubscriptions).values({
      tenantId,
      planId,
      status: "active",
      // An active manual contract must have a future expiry; otherwise the
      // contract gate rejects it before the entitlement-block policy is reached.
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      entitlementBlocked: true,
      entitlementBlockedReason: "manual_review_required",
    });

    await expect(getTenantEntitlementLimit(db, tenantId, "max_printers"))
      .rejects.toBeInstanceOf(TenantEntitlementConfigError);
    const result = await db.execute(sql`SELECT 1 AS admitted FROM tenants t
      WHERE t.id = ${tenantId} AND ${liveTenantSubscriptionPredicate(sql`t.id`)}`);
    expect(result.rows).toHaveLength(0);
  });

  it("does not grant perpetual printing when an active manual contract lacks an expiry", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Missing contract deadline" });
    await db.insert(plans).values({
      id: planId, name: "Manual plan without end",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
    });
    await db.insert(tenantSubscriptions).values({ tenantId, planId, status: "active", currentPeriodEnd: null });
    await expect(getTenantEntitlementLimit(db, tenantId, "max_printers"))
      .rejects.toBeInstanceOf(TenantSubscriptionRequiredError);
    const result = await db.execute(sql`SELECT 1 AS allowed FROM tenants t WHERE t.id = ${tenantId}
      AND ${liveTenantSubscriptionPredicate(sql`t.id`)}`);
    expect(result.rows).toHaveLength(0);
  });

  it.each(["suspended", "deleted"] as const)("rejects live contracts on %s workspaces in both runtime and admin status", async lifecycle => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Inactive workspace", lifecycle });
    await db.insert(plans).values({ id: planId, name: "Live manual contract",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
    });
    await db.insert(tenantSubscriptions).values({ tenantId, planId, status: "active",
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    await expect(requireTenantBillingAccess(db, tenantId)).rejects.toBeInstanceOf(TenantSubscriptionRequiredError);
    await expect(getTenantEntitlementLimit(db, tenantId, "max_printers"))
      .rejects.toBeInstanceOf(TenantSubscriptionRequiredError);
    const status = await db.execute(sql`
      SELECT ${effectiveSubscriptionStatusSql({
        tenantId: sql`t.id`, tenantLifecycle: sql`t.lifecycle`,
        subscriptionStatus: sql`s.status`, entitlementBlocked: sql`s.entitlement_blocked`,
        currentPeriodStart: sql`s.current_period_start`,
      })} AS "effectiveStatus",
      ${liveTenantSubscriptionPredicate(sql`t.id`)} AS "admitted"
      FROM tenants t JOIN tenant_subscriptions s ON s.tenant_id=t.id
      WHERE t.id=${tenantId}
    `);
    expect(status.rows[0]).toMatchObject({ effectiveStatus: "suspended", admitted: false });
  });
  it("fails closed for suspended subscriptions", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Paused Tenant" });
    await db.insert(plans).values({
      id: planId,
      name: "Paused Plan",
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 20 },
    });
    await db.insert(tenantSubscriptions).values({
      tenantId,
      planId,
      status: "suspended",
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });

    await expect(getTenantEntitlementLimit(db, tenantId, "max_printers"))
      .rejects.toBeInstanceOf(TenantSubscriptionRequiredError);
  });
});
