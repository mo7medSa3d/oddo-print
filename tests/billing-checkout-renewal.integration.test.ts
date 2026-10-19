import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { tenants, users, tenantUsers, managerSessions, plans, tenantSubscriptions } from "../src/db/schema";
import { nanoid } from "../src/lib/nanoid";
import { POST as checkout } from "../src/app/api/billing/checkout/route";
import { validateWorkspaceManager } from "../src/lib/manager-auth";
import { applyMigrations, closePool, hasTestDatabase, truncateAll } from "./helpers/pg";
import { gatewayTestSigningKey } from "./helpers/test-secrets";
import { createPlatformSession, platformCookieHeader } from "../src/lib/platform-auth";
import { POST as createPlan } from "../src/app/api/platform/plans/route";
import { PATCH as updatePlan } from "../src/app/api/platform/plans/[id]/route";

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
  stripeRetrieve: vi.fn(),
  validateStripePriceBinding: vi.fn(),
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
    const { stripeRequest, stripeList, stripeRetrieve } = await import("../src/lib/stripe");
    vi.mocked(stripeRetrieve).mockReset();
    vi.mocked(stripeRetrieve).mockImplementation(async (path) => ({
      id: path.split("/").at(-1), customer: "cus_d1", status: "canceled",
      metadata: { tenant_id: "tenant_d1" },
    }));
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

  it("expired active subscription does NOT block renewal after Stripe confirms cancellation", async () => {
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

  it("entitlement-blocked active subscription does NOT block renewal after Stripe confirms cancellation", async () => {
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

  async function seedExpiredSubscription() {
    await db.insert(plans).values({
      id: "plan_d1_recovery", name: "Recovery", stripePriceId: "price_d1_recovery",
      entitlements: { max_agents: 1, max_printers: 1, max_jobs_per_minute: 10, max_concurrent_jobs: 1, max_prints_per_period: 10 },
      currency: "usd", interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_d1", planId: "plan_d1_recovery", status: "active",
      stripeSubscriptionId: "sub_expired", stripeCustomerId: "cus_d1",
      currentPeriodStart: new Date(Date.now() - 7200_000), currentPeriodEnd: new Date(Date.now() - 3600_000),
    });
  }

  it.each([false, true])("never opens a second subscription when Stripe still reports active (blocked=%s)", async (blocked) => {
    await seedExpiredSubscription();
    if (blocked) await db.update(tenantSubscriptions).set({ entitlementBlocked: true }).where(eq(tenantSubscriptions.tenantId, "tenant_d1"));
    const { stripeRequest, stripeRetrieve } = await import("../src/lib/stripe");
    vi.mocked(stripeRetrieve).mockResolvedValueOnce({ id: "sub_expired", customer: "cus_d1", status: "active" });
    const res = await checkout(checkoutRequest("plan_d1_recovery"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SUBSCRIPTION_NEEDS_ATTENTION", status: "active" });
    expect(stripeRequest).not.toHaveBeenCalled();
    const row = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, "tenant_d1") });
    expect(row?.stripeSubscriptionId).toBe("sub_expired");
    expect(row?.checkoutStatus).toBe("none");
  });

  it("does not create a checkout when provider verification is unavailable", async () => {
    await seedExpiredSubscription();
    const { stripeRequest, stripeRetrieve } = await import("../src/lib/stripe");
    vi.mocked(stripeRetrieve).mockRejectedValueOnce(new Error("provider unavailable"));
    const res = await checkout(checkoutRequest("plan_d1_recovery"));
    expect(res.status).toBe(502);
    expect(stripeRequest).not.toHaveBeenCalled();
    const row = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, "tenant_d1") });
    expect(row?.status).toBe("active");
  });

  it.each(["revision", "suspended", "revoked", "identity"])("preserves authority and identity fences during Stripe verification: %s", async (change) => {
    await seedExpiredSubscription();
    const { stripeRequest, stripeRetrieve } = await import("../src/lib/stripe");
    vi.mocked(stripeRetrieve).mockImplementationOnce(async () => {
      if (change === "revision") await db.update(tenantSubscriptions).set({ stripeStateRevision: 1 }).where(eq(tenantSubscriptions.tenantId, "tenant_d1"));
      if (change === "suspended") await db.update(tenants).set({ lifecycle: "suspended" }).where(eq(tenants.id, "tenant_d1"));
      if (change === "revoked") await db.update(managerSessions).set({ revokedAt: new Date() }).where(eq(managerSessions.jti, "test-manager-jti-d1"));
      return { id: "sub_expired", customer: change === "identity" ? "cus_someone_else" : "cus_d1", status: "canceled" };
    });
    const res = await checkout(checkoutRequest("plan_d1_recovery"));
    expect(res.status).toBe(change === "suspended" || change === "revoked" ? 403 : 409);
    expect(stripeRequest).not.toHaveBeenCalled();
    const row = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, "tenant_d1") });
    expect(row?.status).toBe("active");
  });

  it("retains a previously opened replacement checkout after remote terminal verification", async () => {
    await seedExpiredSubscription();
    await db.update(tenantSubscriptions).set({
      checkoutStatus: "open", checkoutPlanId: "plan_d1_recovery", checkoutSessionId: "cs_prior",
      checkoutSessionUrl: "https://checkout.example/prior", checkoutSessionExpiresAt: new Date(Date.now() + 3600_000),
    }).where(eq(tenantSubscriptions.tenantId, "tenant_d1"));
    const { stripeRequest } = await import("../src/lib/stripe");
    const res = await checkout(checkoutRequest("plan_d1_recovery"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ existing: true, url: "https://checkout.example/prior" });
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it.each(["none", "revision", "intent", "suspended", "revoked"])("fences a recovered Stripe subscription against concurrent local changes: %s", async (change) => {
    await seedExpiredSubscription();
    const old = new Date(Date.now() - 26 * 3600_000);
    await db.update(tenantSubscriptions).set({
      status: "cancelled", stripeSubscriptionId: null, checkoutStatus: "creating",
      checkoutPlanId: "plan_d1_recovery", checkoutIdempotencyKey: "checkout-intent-old",
      checkoutIntentCreatedAt: old, updatedAt: old,
    }).where(eq(tenantSubscriptions.tenantId, "tenant_d1"));
    const recovered = {
      id: "sub_recovered", customer: "cus_d1", status: "active",
      current_period_start: Math.floor(Date.now() / 1000) - 3600,
      current_period_end: Math.floor(Date.now() / 1000) + 3600,
      metadata: { tenant_id: "tenant_d1", plan_id: "plan_d1_recovery" },
      items: { data: [{ price: { id: "price_d1_recovery" } }] },
    };
    const { stripeRequest, stripeList, stripeRetrieve } = await import("../src/lib/stripe");
    vi.mocked(stripeList).mockResolvedValueOnce({ data: [recovered], hasMore: false });
    vi.mocked(stripeRetrieve).mockImplementationOnce(async () => {
      if (change === "revision") await db.update(tenantSubscriptions).set({ stripeStateRevision: 1 }).where(eq(tenantSubscriptions.tenantId, "tenant_d1"));
      if (change === "intent") await db.update(tenantSubscriptions).set({ checkoutIdempotencyKey: "checkout-intent-new" }).where(eq(tenantSubscriptions.tenantId, "tenant_d1"));
      if (change === "suspended") await db.update(tenants).set({ lifecycle: "suspended" }).where(eq(tenants.id, "tenant_d1"));
      if (change === "revoked") await db.update(managerSessions).set({ revokedAt: new Date() }).where(eq(managerSessions.jti, "test-manager-jti-d1"));
      return recovered;
    });
    const res = await checkout(checkoutRequest("plan_d1_recovery"));
    expect(res.status).toBe(change === "suspended" || change === "revoked" ? 403 : 409);
    expect(stripeRequest).not.toHaveBeenCalled();
    const row = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, "tenant_d1") });
    expect(row?.stripeSubscriptionId).toBe(change === "none" ? "sub_recovered" : null);
    expect(row?.status).toBe(change === "none" ? "active" : "cancelled");
  });

  async function platformRequest(body: Record<string, unknown>, method: "POST" | "PATCH") {
    vi.stubEnv("GATEWAY_JWT_SECRET", gatewayTestSigningKey());
    await db.update(users).set({ isPlatformOwner: true, emailVerifiedAt: new Date() }).where(eq(users.id, "user_d1"));
    const session = await createPlatformSession("user_d1", "d1@example.test");
    return new Request("http://localhost/api/platform/plans/plan_d1_recovery", {
      method, headers: { "content-type": "application/json", cookie: platformCookieHeader(session.token, session.exp).split(";")[0] },
      body: JSON.stringify(body),
    });
  }

  it.each(["POST", "PATCH"] as const)("rechecks platform owner authority after Stripe Price validation (%s)", async (method) => {
    await seedExpiredSubscription();
    const request = await platformRequest(method === "POST" ? {
      id: "new_catalog_plan", name: "New plan", stripePriceId: "price_new", currency: "usd", interval: "month",
      entitlements: { max_agents: 1, max_printers: 1, max_jobs_per_minute: 10, max_concurrent_jobs: 1, max_prints_per_period: 10 },
    } : { stripePriceId: "price_new" }, method);
    const { validateStripePriceBinding } = await import("../src/lib/stripe");
    vi.mocked(validateStripePriceBinding).mockReset();
    vi.mocked(validateStripePriceBinding).mockImplementationOnce(async () => {
      await db.update(users).set({ isPlatformOwner: false }).where(eq(users.id, "user_d1"));
      return { id: "price_new", active: true, type: "recurring", currency: "usd", interval: "month", productId: "prod_new" };
    });
    const response = method === "POST" ? await createPlan(request) : await updatePlan(request, { params: Promise.resolve({ id: "plan_d1_recovery" }) });
    expect(response.status).toBe(403);
    expect(await db.query.plans.findFirst({ where: eq(plans.id, "new_catalog_plan") })).toBeUndefined();
    expect((await db.query.plans.findFirst({ where: eq(plans.id, "plan_d1_recovery") }))?.stripePriceId).toBe("price_d1_recovery");
  });

  it("archives a catalog plan locally without depending on Stripe availability", async () => {
    await seedExpiredSubscription();
    const request = await platformRequest({ isActive: false }, "PATCH");
    const { validateStripePriceBinding } = await import("../src/lib/stripe");
    vi.mocked(validateStripePriceBinding).mockReset();
    vi.mocked(validateStripePriceBinding).mockRejectedValue(new Error("provider unavailable"));
    const response = await updatePlan(request, { params: Promise.resolve({ id: "plan_d1_recovery" }) });
    expect(response.status).toBe(200);
    expect(validateStripePriceBinding).not.toHaveBeenCalled();
    expect((await db.query.plans.findFirst({ where: eq(plans.id, "plan_d1_recovery") }))?.isActive).toBe(false);
    expect((await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, "tenant_d1") }))?.planId).toBe("plan_d1_recovery");
  });
});
