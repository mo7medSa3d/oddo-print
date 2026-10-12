import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { tenants, users, tenantUsers, managerSessions, plans, tenantSubscriptions } from "../src/db/schema";
import { nanoid } from "../src/lib/nanoid";
import { POST as checkout } from "../src/app/api/billing/checkout/route";
import { validateWorkspaceManager } from "../src/lib/manager-auth";
import { applyMigrations, closePool, hasTestDatabase, truncateAll } from "./helpers/pg";

vi.mock(import("../src/lib/manager-auth"), async (importOriginal) => ({
  ...(await importOriginal()),
  validateManager: vi.fn(),
  validateWorkspaceManager: vi.fn(),
}));
vi.mock("../src/lib/authorization", () => ({
  requireManagerPermission: vi.fn(),
  hasManagerPermission: vi.fn(() => true),
}));
vi.mock(import("../src/lib/stripe"), async (importOriginal) => ({
  ...(await importOriginal()),
  stripeRequest: vi.fn(),
  stripeList: vi.fn(),
}));

const suite = describe.skipIf(!hasTestDatabase);

function checkoutRequest(planId: string): Request {
  return new Request("http://localhost/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planId }),
  });
}

suite("billing checkout renewal after expiry (D-1)", () => {
  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => {
    await truncateAll();
    vi.stubEnv("APP_BASE_URL", "https://billing.test");
    const managerExpiry = Math.floor(Date.now() / 1000) + 3600;
    vi.mocked(validateWorkspaceManager).mockResolvedValue({
      jti: "test-manager-jti-d1", iat: Math.floor(Date.now() / 1000) - 10, exp: managerExpiry,
      sub: "manager", tenantId: "tenant_d1", userId: "user_d1", role: "owner",
    });
    const { stripeRequest, stripeList } = await import("../src/lib/stripe");
    vi.mocked(stripeList).mockReset();
    vi.mocked(stripeList).mockResolvedValue({ data: [], hasMore: false });
    vi.mocked(stripeRequest).mockReset();
    vi.mocked(stripeRequest).mockImplementation(async (path: string, _f: URLSearchParams, idempotencyKey?: string) => {
      if (path === "customers") return { id: "cus_d1" };
      if (path === "checkout/sessions") return { id: `cs_${idempotencyKey}`, url: `https://checkout.example/${idempotencyKey}` };
      throw new Error(`unexpected Stripe path: ${path}`);
    });
    await db.insert(tenants).values({ id: "tenant_d1", name: "D1 Tenant" });
    await db.insert(users).values({ id: "user_d1", email: "d1@example.test", passwordHash: "unused" });
    await db.insert(tenantUsers).values({ userId: "user_d1", tenantId: "tenant_d1", role: "owner" });
    await db.insert(managerSessions).values({
      jti: "test-manager-jti-d1", tenantId: "tenant_d1", userId: "user_d1", role: "owner",
      expiresAt: new Date(managerExpiry * 1000),
    });
  });
  afterAll(async () => { await closePool(); });

  it("live active subscription still returns already_subscribed", async () => {
    const plan = `plan_d1_${nanoid(6)}`;
    await db.insert(plans).values({
      id: plan, name: "P", stripePriceId: `price_${nanoid(6)}`,
      entitlements: { max_agents: 1, max_printers: 1, max_jobs_per_minute: 10, max_concurrent_jobs: 1, max_prints_per_period: 10 },
      currency: "usd", interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_d1", planId: plan, status: "active",
      stripeSubscriptionId: "sub_live", stripeCustomerId: "cus_d1",
      currentPeriodStart: new Date(Date.now() - 3600_000),
      currentPeriodEnd: new Date(Date.now() + 3600_000),
    });
    const res = await checkout(checkoutRequest(plan));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toMatch(/already has a Stripe subscription/);
  });

  it("expired active subscription does NOT block renewal", async () => {
    const plan = `plan_d1_${nanoid(6)}`;
    await db.insert(plans).values({
      id: plan, name: "P", stripePriceId: `price_${nanoid(6)}`,
      entitlements: { max_agents: 1, max_printers: 1, max_jobs_per_minute: 10, max_concurrent_jobs: 1, max_prints_per_period: 10 },
      currency: "usd", interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_d1", planId: plan, status: "active",
      stripeSubscriptionId: "sub_expired", stripeCustomerId: "cus_d1",
      currentPeriodStart: new Date(Date.now() - 7200_000),
      currentPeriodEnd: new Date(Date.now() - 3600_000),
    });
    const res = await checkout(checkoutRequest(plan));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string };
    expect(typeof body.url).toBe("string");
  });

  it("entitlement-blocked active subscription does NOT block renewal", async () => {
    const plan = `plan_d1_${nanoid(6)}`;
    await db.insert(plans).values({
      id: plan, name: "P", stripePriceId: `price_${nanoid(6)}`,
      entitlements: { max_agents: 1, max_printers: 1, max_jobs_per_minute: 10, max_concurrent_jobs: 1, max_prints_per_period: 10 },
      currency: "usd", interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_d1", planId: plan, status: "active",
      stripeSubscriptionId: "sub_blocked", stripeCustomerId: "cus_d1",
      currentPeriodStart: new Date(Date.now() - 3600_000),
      currentPeriodEnd: new Date(Date.now() + 3600_000),
      entitlementBlocked: true, entitlementBlockedReason: "stripe_price_unmapped:price_x",
    });
    const res = await checkout(checkoutRequest(plan));
    expect(res.status).toBe(200);
  });
});
