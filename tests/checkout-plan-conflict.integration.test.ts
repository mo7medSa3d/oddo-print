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

suite("billing checkout plan-conflict fence", () => {
  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => {
    await truncateAll();
    const managerExpiry = Math.floor(Date.now() / 1000) + 3600;
    vi.mocked(validateWorkspaceManager).mockResolvedValue({
      jti: "test-manager-jti-1234567890",
      iat: Math.floor(Date.now() / 1000) - 10,
      exp: managerExpiry,
      sub: "manager",
      tenantId: "tenant_checkout_conflict",
      userId: "user_checkout_conflict",
      role: "owner",
    });
    const { stripeRequest, stripeList } = await import("../src/lib/stripe");
    vi.mocked(stripeList).mockReset();
    // Aged Checkout intents may only rotate after read-side reconciliation
    // proves there is no non-terminal Stripe subscription. Keep the default
    // integration fixture explicit and offline: no real Stripe GET is allowed.
    vi.mocked(stripeList).mockResolvedValue({ data: [], hasMore: false });
    vi.mocked(stripeRequest).mockImplementation(async (path: string, _form: URLSearchParams, idempotencyKey?: string) => {
      if (path === "customers") return { id: "cus_checkout_conflict" };
      if (path === "checkout/sessions") return { id: `cs_${idempotencyKey}`, url: `https://checkout.example/${idempotencyKey}` };
      throw new Error(`unexpected Stripe path: ${path}`);
    });
    await db.insert(tenants).values({ id: "tenant_checkout_conflict", name: "Checkout Conflict Tenant" });
    // Real mutation authority is rechecked inside the transaction, not just at the mocked login boundary.
    await db.insert(users).values({ id: "user_checkout_conflict", email: "checkout-conflict@example.test", passwordHash: "unused" });
    await db.insert(tenantUsers).values({ userId: "user_checkout_conflict", tenantId: "tenant_checkout_conflict", role: "owner" });
    await db.insert(managerSessions).values({
      jti: "test-manager-jti-1234567890", tenantId: "tenant_checkout_conflict",
      userId: "user_checkout_conflict", role: "owner", expiresAt: new Date(managerExpiry * 1000),
    });
  });
  afterAll(async () => { await closePool(); });

  it("never returns another plan's checkout URL: requesting plan B while plan A has an open session is a named 409 conflict", async () => {
    const planA = `plan_a_${nanoid(6)}`;
    const planB = `plan_b_${nanoid(6)}`;
    await db.insert(plans).values([
      { id: planA, name: "Starter Monthly", stripePriceId: `price_a_${nanoid(6)}`, entitlements: { max_agents: 1, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 4, max_prints_per_period: 100 }, currency: "usd", interval: "month" },
      { id: planB, name: "Scale Monthly", stripePriceId: `price_b_${nanoid(6)}`, entitlements: { max_agents: 10, max_printers: 25, max_jobs_per_minute: 300, max_concurrent_jobs: 16, max_prints_per_period: 1000 }, currency: "usd", interval: "month" },
    ]);

    const first = await checkout(checkoutRequest(planA));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { url?: string };
    expect(typeof firstBody.url).toBe("string");
    const urlA = firstBody.url!;

    const second = await checkout(checkoutRequest(planB));
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { error?: string; code?: string; openPlanId?: string; url?: string };
    expect(secondBody.code).toBe("CHECKOUT_PLAN_CONFLICT");
    expect(secondBody.openPlanId).toBe(planA);
    expect(secondBody.error).toContain("Starter Monthly");
    // The decisive assertion: no URL may leave the server for an unrequested plan.
    expect(secondBody.url).toBeUndefined();

    // The stored intent still belongs to plan A and remains open.
    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, "tenant_checkout_conflict"),
    });
    expect(sub?.checkoutPlanId).toBe(planA);
    expect(sub?.checkoutStatus).toBe("open");
    expect(sub?.checkoutSessionUrl).toBe(urlA);
  });

  it("still replays the same plan's open session instead of minting a duplicate", async () => {
    const planA = `plan_a_${nanoid(6)}`;
    await db.insert(plans).values({
      id: planA, name: "Starter Monthly", stripePriceId: `price_a_${nanoid(6)}`,
      entitlements: { max_agents: 1, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 4, max_prints_per_period: 100 }, currency: "usd", interval: "month",
    });

    const first = await checkout(checkoutRequest(planA));
    expect(first.status).toBe(200);
    const urlA = ((await first.json()) as { url: string }).url;

    const replay = await checkout(checkoutRequest(planA));
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { url: string; existing: boolean };
    expect(replayBody.existing).toBe(true);
    expect(replayBody.url).toBe(urlA);
  });

  it("releases the fence once the open session expires: plan B then proceeds normally", async () => {
    const planA = `plan_a_${nanoid(6)}`;
    const planB = `plan_b_${nanoid(6)}`;
    await db.insert(plans).values([
      { id: planA, name: "Starter Monthly", stripePriceId: `price_a_${nanoid(6)}`, entitlements: { max_agents: 1, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 4, max_prints_per_period: 100 }, currency: "usd", interval: "month" },
      { id: planB, name: "Scale Monthly", stripePriceId: `price_b_${nanoid(6)}`, entitlements: { max_agents: 10, max_printers: 25, max_jobs_per_minute: 300, max_concurrent_jobs: 16, max_prints_per_period: 1000 }, currency: "usd", interval: "month" },
    ]);

    await checkout(checkoutRequest(planA));
    await db.update(tenantSubscriptions)
      .set({ checkoutSessionExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(tenantSubscriptions.tenantId, "tenant_checkout_conflict"));

    const next = await checkout(checkoutRequest(planB));
    expect(next.status).toBe(200);
    const body = (await next.json()) as { url?: string; existing?: boolean };
    expect(body.existing).toBeFalsy();
    expect(typeof body.url).toBe("string");

    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, "tenant_checkout_conflict"),
    });
    expect(sub?.checkoutPlanId).toBe(planB);
    expect(sub?.checkoutStatus).toBe("open");
  });

  it("also conflicts while a different plan's creating intent is unresolved", async () => {
    const planA = `plan_a_${nanoid(6)}`;
    const planB = `plan_b_${nanoid(6)}`;
    await db.insert(plans).values([
      { id: planA, name: "Starter Monthly", stripePriceId: `price_a_${nanoid(6)}`, entitlements: { max_agents: 1, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 4, max_prints_per_period: 100 }, currency: "usd", interval: "month" },
      { id: planB, name: "Scale Monthly", stripePriceId: `price_b_${nanoid(6)}`, entitlements: { max_agents: 10, max_printers: 25, max_jobs_per_minute: 300, max_concurrent_jobs: 16, max_prints_per_period: 1000 }, currency: "usd", interval: "month" },
    ]);

    // Simulate an intent whose Stripe call never finalized (still 'creating').
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_checkout_conflict",
      planId: planA,
      status: "cancelled",
      checkoutStatus: "creating",
      checkoutPlanId: planA,
      checkoutIdempotencyKey: "checkout-intent-chk_creating_conflict",
    });

    const response = await checkout(checkoutRequest(planB));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code?: string; openPlanId?: string; error?: string };
    expect(body.code).toBe("CHECKOUT_PLAN_CONFLICT");
    expect(body.openPlanId).toBe(planA);
    expect(body.error).toContain("Starter Monthly");
  });
  it("does not replay an aged idempotency key while a recent ambiguous Checkout Session could still be payable", async () => {
    const planA = `plan_a_${nanoid(6)}`;
    await db.insert(plans).values({
      id: planA, name: "Starter Monthly", stripePriceId: `price_a_${nanoid(6)}`,
      entitlements: { max_agents: 1, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 4, max_prints_per_period: 100 }, currency: "usd", interval: "month",
    });
    const oldKey = "checkout-intent-chk_aged_recent_attempt";
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_checkout_conflict",
      planId: planA,
      status: "cancelled",
      stripeCustomerId: "cus_checkout_conflict",
      checkoutStatus: "creating",
      checkoutPlanId: planA,
      checkoutIdempotencyKey: oldKey,
      checkoutRequestParams: {
        mode: "subscription",
        client_reference_id: "tenant_checkout_conflict",
        success_url: "http://localhost/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "http://localhost/billing?checkout=cancelled",
        "line_items[0][price]": `price_a_${nanoid(6)}`,
        "line_items[0][quantity]": "1",
      },
      checkoutIntentCreatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { stripeRequest } = await import("../src/lib/stripe");
    vi.mocked(stripeRequest).mockClear();

    const response = await checkout(checkoutRequest(planA));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code?: string; retryAfterSeconds?: number };
    expect(body.code).toBe("CHECKOUT_RECONCILIATION_PENDING");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(vi.mocked(stripeRequest)).not.toHaveBeenCalled();

    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, "tenant_checkout_conflict"),
    });
    expect(sub?.checkoutIdempotencyKey).toBe(oldKey);
    expect(sub?.checkoutStatus).toBe("creating");
  });

  it("rotates an aged creating intent only after a full maximum Checkout Session lifetime since the last attempt", async () => {
    const planA = `plan_a_${nanoid(6)}`;
    const priceA = `price_a_${nanoid(6)}`;
    await db.insert(plans).values({
      id: planA, name: "Starter Monthly", stripePriceId: priceA,
      entitlements: { max_agents: 1, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 4, max_prints_per_period: 100 }, currency: "usd", interval: "month",
    });
    const oldKey = "checkout-intent-chk_abandonable";
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_checkout_conflict",
      planId: planA,
      status: "cancelled",
      stripeCustomerId: "cus_checkout_conflict",
      checkoutStatus: "creating",
      checkoutPlanId: planA,
      checkoutIdempotencyKey: oldKey,
      checkoutRequestParams: {
        mode: "subscription", client_reference_id: "tenant_checkout_conflict",
        success_url: "http://localhost/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "http://localhost/billing?checkout=cancelled",
        "line_items[0][price]": priceA, "line_items[0][quantity]": "1",
      },
      checkoutIntentCreatedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const { stripeRequest } = await import("../src/lib/stripe");
    vi.mocked(stripeRequest).mockClear();

    const response = await checkout(checkoutRequest(planA));
    expect(response.status).toBe(200);
    expect(typeof ((await response.json()) as { url?: string }).url).toBe("string");

    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, "tenant_checkout_conflict"),
    });
    expect(sub?.checkoutStatus).toBe("open");
    expect(sub?.checkoutIdempotencyKey).toMatch(/^checkout-intent-chk_/);
    expect(sub?.checkoutIdempotencyKey).not.toBe(oldKey);
    expect(vi.mocked(stripeRequest)).toHaveBeenCalledWith(
      "checkout/sessions",
      expect.any(URLSearchParams),
      sub?.checkoutIdempotencyKey,
    );
  });

  it("releases an aged different-plan creating fence after the same safety window", async () => {
    const planA = `plan_a_${nanoid(6)}`;
    const planB = `plan_b_${nanoid(6)}`;
    await db.insert(plans).values([
      { id: planA, name: "Starter Monthly", stripePriceId: `price_a_${nanoid(6)}`, entitlements: { max_agents: 1, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 4, max_prints_per_period: 100 }, currency: "usd", interval: "month" },
      { id: planB, name: "Scale Monthly", stripePriceId: `price_b_${nanoid(6)}`, entitlements: { max_agents: 10, max_printers: 25, max_jobs_per_minute: 300, max_concurrent_jobs: 16, max_prints_per_period: 1000 }, currency: "usd", interval: "month" },
    ]);
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_checkout_conflict",
      planId: planA,
      status: "cancelled",
      stripeCustomerId: "cus_checkout_conflict",
      checkoutStatus: "creating",
      checkoutPlanId: planA,
      checkoutIdempotencyKey: "checkout-intent-chk_old_plan",
      checkoutRequestParams: { mode: "subscription" },
      checkoutIntentCreatedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const response = await checkout(checkoutRequest(planB));
    expect(response.status).toBe(200);

    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, "tenant_checkout_conflict"),
    });
    expect(sub?.checkoutPlanId).toBe(planB);
    expect(sub?.checkoutStatus).toBe("open");
    expect(sub?.checkoutIdempotencyKey).not.toBe("checkout-intent-chk_old_plan");
  });

  it("refreshes the recovery fence immediately before an ambiguous Stripe Checkout attempt", async () => {
    const planA = `plan_a_${nanoid(6)}`;
    const priceA = `price_a_${nanoid(6)}`;
    await db.insert(plans).values({
      id: planA, name: "Starter Monthly", stripePriceId: priceA,
      entitlements: { max_agents: 1, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 4, max_prints_per_period: 100 }, currency: "usd", interval: "month",
    });
    const oldUpdatedAt = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_checkout_conflict",
      planId: planA,
      status: "cancelled",
      stripeCustomerId: "cus_checkout_conflict",
      checkoutStatus: "creating",
      checkoutPlanId: planA,
      checkoutIdempotencyKey: "checkout-intent-chk_ambiguous_attempt",
      checkoutRequestParams: {
        mode: "subscription", client_reference_id: "tenant_checkout_conflict",
        success_url: "http://localhost/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "http://localhost/billing?checkout=cancelled",
        "line_items[0][price]": priceA, "line_items[0][quantity]": "1",
      },
      checkoutIntentCreatedAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: oldUpdatedAt,
    });
    const { stripeRequest } = await import("../src/lib/stripe");
    vi.mocked(stripeRequest).mockImplementation(async (path: string) => {
      if (path === "checkout/sessions") throw new Error("network timeout after request may have been sent");
      throw new Error(`unexpected Stripe path: ${path}`);
    });

    const response = await checkout(checkoutRequest(planA));
    expect(response.status).toBe(502);

    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, "tenant_checkout_conflict"),
    });
    expect(sub?.checkoutStatus).toBe("creating");
    expect(sub?.updatedAt?.getTime()).toBeGreaterThan(oldUpdatedAt.getTime());
  });

  it("does not touch Stripe Checkout after a concurrent transition advances the creating intent", async () => {
    const planA = `plan_a_${nanoid(6)}`;
    const priceA = `price_a_${nanoid(6)}`;
    await db.insert(plans).values({
      id: planA, name: "Starter Monthly", stripePriceId: priceA,
      entitlements: { max_agents: 1, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 4, max_prints_per_period: 100 }, currency: "usd", interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId: "tenant_checkout_conflict",
      planId: planA,
      status: "cancelled",
      checkoutStatus: "creating",
      checkoutPlanId: planA,
      checkoutIdempotencyKey: "checkout-intent-chk_concurrent_transition",
      checkoutRequestParams: {
        mode: "subscription", client_reference_id: "tenant_checkout_conflict",
        success_url: "http://localhost/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "http://localhost/billing?checkout=cancelled",
        "line_items[0][price]": priceA, "line_items[0][quantity]": "1",
      },
      checkoutIntentCreatedAt: new Date(),
    });

    const existingUrl = "https://checkout.example/existing-concurrent-session";
    const { stripeRequest } = await import("../src/lib/stripe");
    vi.mocked(stripeRequest).mockClear();
    vi.mocked(stripeRequest).mockImplementationOnce(async (path: string) => {
      expect(path).toBe("customers");
      await db.update(tenantSubscriptions)
        .set({
          checkoutStatus: "open",
          checkoutSessionId: "cs_concurrent_transition",
          checkoutSessionUrl: existingUrl,
          checkoutSessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
        .where(eq(tenantSubscriptions.tenantId, "tenant_checkout_conflict"));
      return { id: "cus_concurrent_transition" };
    });

    const response = await checkout(checkoutRequest(planA));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, existing: true, url: existingUrl });
    expect(vi.mocked(stripeRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stripeRequest).mock.calls[0]?.[0]).toBe("customers");
  });

});
