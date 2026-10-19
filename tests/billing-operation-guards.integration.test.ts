import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { tenants, users, tenantUsers, managerSessions, plans, tenantSubscriptions } from "../src/db/schema";
import { runBillingOperation } from "../src/lib/billing-operation";
import { applyMigrations, closePool, hasTestDatabase, truncateAll } from "./helpers/pg";
import type { ManagerClaims } from "../src/lib/manager-auth";
import { TenantSuspendedError } from "../src/lib/tenant-guard";

vi.mock("../src/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/stripe")>();
  return { ...actual, stripeRequest: vi.fn(async () => { throw new Error("Stripe must not be called for rejected states"); }) };
});

const suite = describe.skipIf(!hasTestDatabase);

const CANCEL = {
  type: "cancel" as const,
  missingSubscriptionError: "No active Stripe subscription",
  stripeParams: new URLSearchParams({ cancel_at_period_end: "true" }),
  cancelAtPeriodEnd: true,
  logLabel: "cancel",
};
const RESUME = {
  type: "resume" as const,
  missingSubscriptionError: "No Stripe subscription",
  stripeParams: new URLSearchParams({ cancel_at_period_end: "false" }),
  cancelAtPeriodEnd: false,
  logLabel: "resume",
};

suite("billing operation status matrix (D-7)", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const claims: ManagerClaims = {
    jti: "test-manager-jti-billop", iat: exp - 3600, exp,
    sub: "manager", tenantId: "tenant_billop", userId: "user_billop", role: "owner",
  } as ManagerClaims;

  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => {
    await truncateAll();
    vi.stubEnv("APP_BASE_URL", "https://billing.test");
    await db.insert(tenants).values({ id: "tenant_billop", name: "Billop Tenant" });
    await db.insert(users).values({ id: "user_billop", email: "billop@example.test", passwordHash: "unused" });
    await db.insert(tenantUsers).values({ userId: "user_billop", tenantId: "tenant_billop", role: "owner" });
    await db.insert(managerSessions).values({
      jti: "test-manager-jti-billop", tenantId: "tenant_billop", userId: "user_billop",
      role: "owner", expiresAt: new Date(exp * 1000),
    });
    await db.insert(plans).values({
      id: "plan_billop", name: "P", stripePriceId: "price_billop",
      entitlements: { max_agents: 1, max_printers: 1, max_jobs_per_minute: 10, max_concurrent_jobs: 1, max_prints_per_period: 10 },
      currency: "usd", interval: "month",
    });
  });
  afterAll(async () => { await closePool(); });

  async function seedStatus(status: string) {
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_billop", planId: "plan_billop", status: status as never,
      stripeSubscriptionId: "sub_billop", stripeCustomerId: "cus_billop",
    });
  }

  it.each(["cancelled", "incomplete_expired"])("cancel on %s is rejected without Stripe", async (status) => {
    await seedStatus(status);
    const res = await runBillingOperation(claims, CANCEL);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already ended/);
  });

  it("cancel on paused is rejected without Stripe", async () => {
    await seedStatus("paused");
    const res = await runBillingOperation(claims, CANCEL);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/paused/i);
  });

  it.each(["cancelled", "incomplete_expired"])("resume on %s is rejected without Stripe", async (status) => {
    await seedStatus(status);
    const res = await runBillingOperation(claims, RESUME);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already ended|new checkout/);
  });

  it("cancel on active proceeds to Stripe", async () => {
    await seedStatus("active");
    const { stripeRequest } = await import("../src/lib/stripe");
    vi.mocked(stripeRequest).mockResolvedValueOnce({ id: "sub_billop" });
    const res = await runBillingOperation(claims, CANCEL);
    expect(res.status).toBe(200);
    const row = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, "tenant_billop") });
    expect(row?.cancelAtPeriodEnd).toBe(true);
  });

  it("rechecks tenant lifecycle before claiming an admitted billing mutation", async () => {
    await seedStatus("active");
    const { stripeRequest } = await import("../src/lib/stripe");
    vi.mocked(stripeRequest).mockClear();
    await db.update(tenants).set({ lifecycle: "suspended" }).where(eq(tenants.id, "tenant_billop"));
    await expect(runBillingOperation(claims, CANCEL)).rejects.toBeInstanceOf(TenantSuspendedError);
    expect(stripeRequest).not.toHaveBeenCalled();
    const row = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, "tenant_billop") });
    expect(row?.billingOperationId).toBeNull();
  });
});
