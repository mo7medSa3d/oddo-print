import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { tenants, plans, tenantSubscriptions } from "../src/db/schema";
import { nanoid } from "../src/lib/nanoid";
import { POST as checkout } from "../src/app/api/billing/checkout/route";
import { applyMigrations, closePool, hasTestDatabase, truncateAll } from "./helpers/pg";

vi.mock("../src/lib/manager-auth", () => ({
  validateManager: vi.fn(),
}));
vi.mock("../src/lib/authorization", () => ({
  requireManagerPermission: vi.fn(),
  hasManagerPermission: vi.fn(() => true),
}));
vi.mock("../src/lib/stripe", () => ({
  stripeRequest: vi.fn(),
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
    const { validateManager } = await import("../src/lib/manager-auth");
    vi.mocked(validateManager).mockResolvedValue({
      jti: "test-manager-jti-1234567890",
      iat: Math.floor(Date.now() / 1000) - 10,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: "manager",
      tenantId: "tenant_checkout_conflict",
      userId: "user_checkout_conflict",
      role: "owner",
    });
    const { stripeRequest } = await import("../src/lib/stripe");
    vi.mocked(stripeRequest).mockImplementation(async (path: string, _form: URLSearchParams, idempotencyKey?: string) => {
      if (path === "customers") return { id: "cus_checkout_conflict" };
      if (path === "checkout/sessions") return { id: `cs_${idempotencyKey}`, url: `https://checkout.example/${idempotencyKey}` };
      throw new Error(`unexpected Stripe path: ${path}`);
    });
    await db.insert(tenants).values({ id: "tenant_checkout_conflict", name: "Checkout Conflict Tenant" });
  });
  afterAll(async () => { await closePool(); });

  it("never returns another plan's checkout URL: requesting plan B while plan A has an open session is a named 409 conflict", async () => {
    const planA = `plan_a_${nanoid(6)}`;
    const planB = `plan_b_${nanoid(6)}`;
    await db.insert(plans).values([
      { id: planA, name: "Starter Monthly", stripePriceId: `price_a_${nanoid(6)}`, entitlements: { max_agents: 1 }, currency: "usd", interval: "month" },
      { id: planB, name: "Scale Monthly", stripePriceId: `price_b_${nanoid(6)}`, entitlements: { max_agents: 10 }, currency: "usd", interval: "month" },
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
      entitlements: { max_agents: 1 }, currency: "usd", interval: "month",
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
      { id: planA, name: "Starter Monthly", stripePriceId: `price_a_${nanoid(6)}`, entitlements: { max_agents: 1 }, currency: "usd", interval: "month" },
      { id: planB, name: "Scale Monthly", stripePriceId: `price_b_${nanoid(6)}`, entitlements: { max_agents: 10 }, currency: "usd", interval: "month" },
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
      { id: planA, name: "Starter Monthly", stripePriceId: `price_a_${nanoid(6)}`, entitlements: { max_agents: 1 }, currency: "usd", interval: "month" },
      { id: planB, name: "Scale Monthly", stripePriceId: `price_b_${nanoid(6)}`, entitlements: { max_agents: 10 }, currency: "usd", interval: "month" },
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
});
