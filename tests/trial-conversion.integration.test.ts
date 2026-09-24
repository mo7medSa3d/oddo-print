import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import { tenants, plans, tenantSubscriptions } from "../src/db/schema";
import { nanoid } from "../src/lib/nanoid";
import { POST as checkout } from "../src/app/api/billing/checkout/route";
import { POST as webhook } from "../src/app/api/billing/webhook/route";
import { stripeRequest } from "../src/lib/stripe";
import { applyMigrations, closePool, hasTestDatabase, truncateAll } from "./helpers/pg";

vi.mock("../src/lib/manager-auth", () => ({
  validateManager: vi.fn(),
}));
vi.mock("../src/lib/authorization", () => ({
  requireManagerPermission: vi.fn(),
  hasManagerPermission: vi.fn(() => true),
}));
const { stripeRetrieveMock } = vi.hoisted(() => ({ stripeRetrieveMock: vi.fn() }));

vi.mock("../src/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/stripe")>();
  return {
    ...actual,
    stripeRequest: vi.fn(),
    stripeRetrieve: stripeRetrieveMock,
    verifyStripeSignature: vi.fn(() => true),
  };
});

const suite = describe.skipIf(!hasTestDatabase);

const TENANT = "tenant_trial_convert";
const CREATED_BASE = 1_790_000_000; // unix seconds; well above the 1e9 seconds heuristic

function checkoutRequest(planId: string): Request {
  return new Request("http://localhost/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planId }),
  });
}

function webhookRequest(eventId: string, eventType: string, object: Record<string, unknown>, createdSeconds: number): Request {
  return new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=test" },
    body: JSON.stringify({ id: eventId, type: eventType, created: createdSeconds, data: { object } }),
  });
}

async function subscriptionRow() {
  return db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, TENANT) });
}

async function subscriptionRowCount(): Promise<number> {
  const result = await db.execute(sql`SELECT COUNT(*)::int AS n FROM tenant_subscriptions WHERE tenant_id = ${TENANT}`);
  return (result.rows[0] as { n: number }).n;
}

function sessionCreateCalls(): number {
  return vi.mocked(stripeRequest).mock.calls.filter(([path]) => path === "checkout/sessions").length;
}

suite("platform-trial to paid conversion invariants", () => {
  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_trial_convert";
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    const { validateManager } = await import("../src/lib/manager-auth");
    vi.mocked(validateManager).mockResolvedValue({
      jti: "test-manager-jti-1234567890",
      iat: Math.floor(Date.now() / 1000) - 10,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: "manager",
      tenantId: TENANT,
      userId: "user_trial_convert",
      role: "owner",
    });
    const { stripeRequest } = await import("../src/lib/stripe");
    vi.mocked(stripeRequest).mockReset();
    stripeRetrieveMock.mockReset();
    stripeRetrieveMock.mockImplementation(async (path: string) => ({
      id: decodeURIComponent(path.split("/").pop() ?? ""),
      object: "subscription",
      customer: "cus_trial_convert",
      status: "active",
      items: { data: [] },
      metadata: { tenant_id: TENANT },
    }));
    vi.mocked(stripeRequest).mockImplementation(async (path: string, _form: URLSearchParams, idempotencyKey?: string) => {
      if (path === "customers") return { id: "cus_trial_convert" };
      if (path === "checkout/sessions") {
        return { id: `cs_${idempotencyKey}`, url: `https://checkout.example/${idempotencyKey}`, expires_at: Math.floor(Date.now() / 1000) + 3600 };
      }
      throw new Error(`unexpected Stripe path: ${path}`);
    });
    await db.insert(tenants).values({ id: TENANT, name: "Trial Convert Tenant" });
  });
  afterAll(async () => { await closePool(); });

  it("platform trial -> Keep this plan -> exactly one checkout session -> webhooks convert the SAME row to active on the same plan", async () => {
    const trialPlan = `plan_trial_${nanoid(6)}`;
    const priceId = `price_trial_${nanoid(6)}`;
    await db.insert(plans).values({
      id: trialPlan, name: "HTTP Test", stripePriceId: priceId,
      entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 100 }, currency: "usd", interval: "month",
    });
    await db.insert(tenantSubscriptions).values({
      tenantId: TENANT,
      planId: trialPlan,
      status: "trialing",
      currentPeriodEnd: new Date(Date.now() + 27 * 24 * 3600 * 1000),
      trialStartedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
    });

    // Keep this plan (first click): a checkout session is minted.
    const first = await checkout(checkoutRequest(trialPlan));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { url: string; existing?: boolean };
    expect(firstBody.existing).toBeFalsy();
    expect(typeof firstBody.url).toBe("string");

    // Keep this plan again (impatient double click): the SAME session replays,
    // and Stripe is NOT asked for a second subscription session.
    const second = await checkout(checkoutRequest(trialPlan));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { url: string; existing?: boolean };
    expect(secondBody.existing).toBe(true);
    expect(secondBody.url).toBe(firstBody.url);
    expect(sessionCreateCalls()).toBe(1);

    // Still a platform trial: no Stripe identity bound yet.
    const mid = await subscriptionRow();
    expect(mid?.status).toBe("trialing");
    expect(mid?.stripeSubscriptionId ?? null).toBeNull();
    expect(mid?.checkoutStatus).toBe("open");
    expect(mid?.checkoutPlanId).toBe(trialPlan);

    // Webhook handling reads the current Stripe subscription snapshot.
    // Keep the integration deterministic and aligned with the selected trial plan.
    stripeRetrieveMock.mockResolvedValueOnce({
      id: "sub_trial_convert",
      object: "subscription",
      customer: "cus_trial_convert",
      status: "trialing",
      metadata: { tenant_id: TENANT },
      items: { data: [{ price: { id: priceId } }] },
    });
    // Stripe: checkout completed.
    const completed = await webhook(webhookRequest(
      `evt_${nanoid(10)}`,
      "checkout.session.completed",
      {
        id: "cs_trial_convert_1",
        object: "checkout.session",
        customer: "cus_trial_convert",
        subscription: "sub_trial_convert",
        client_reference_id: TENANT,
      },
      CREATED_BASE + 10,
    ));
    expect(completed.status).toBe(200);

    // The trial ROW is adopted, not replaced: same tenant row, now bound.
    const bound = await subscriptionRow();
    expect(bound?.stripeSubscriptionId).toBe("sub_trial_convert");
    expect(bound?.stripeCustomerId).toBe("cus_trial_convert");
    expect(bound?.checkoutStatus).toBe("completed");
    expect(bound?.planId).toBe(trialPlan);
    // Conversion binds the subscription but does not flip entitlement state
    // before Stripe says so: the row remains trialing until the subscription
    // event arrives.
    expect(bound?.status).toBe("trialing");
    expect(await subscriptionRowCount()).toBe(1);

    // Stripe: the subscription object arrives (active, same price/plan).
    const periodEndSeconds = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    stripeRetrieveMock.mockResolvedValueOnce({
      id: "sub_trial_convert",
      object: "subscription",
      customer: "cus_trial_convert",
      status: "active",
      current_period_end: periodEndSeconds,
      cancel_at_period_end: false,
      metadata: { tenant_id: TENANT, plan_id: trialPlan },
      items: { data: [{ price: { id: priceId } }] },
    });
    const created = await webhook(webhookRequest(
      `evt_${nanoid(10)}`,
      "customer.subscription.created",
      {
        id: "sub_trial_convert",
        object: "subscription",
        customer: "cus_trial_convert",
        status: "active",
        created: CREATED_BASE + 11,
        current_period_end: periodEndSeconds,
        cancel_at_period_end: false,
        items: { data: [{ price: { id: priceId } }] },
        metadata: { tenant_id: TENANT, plan_id: trialPlan },
      },
      CREATED_BASE + 11,
    ));
    expect(created.status).toBe(200);

    const active = await subscriptionRow();
    expect(active?.status).toBe("active");
    expect(active?.planId).toBe(trialPlan); // entitlements remain on the same plan
    expect(active?.stripeSubscriptionId).toBe("sub_trial_convert");
    expect(active?.cancelAtPeriodEnd).toBe(false);
    expect(active?.currentPeriodEnd?.getTime()).toBe(periodEndSeconds * 1000);
    expect(await subscriptionRowCount()).toBe(1);
    // End-to-end: still exactly one Stripe checkout session was ever created.
    expect(sessionCreateCalls()).toBe(1);
  });

  it("canceled checkout leaves the platform trial unchanged; expiry releases only the intent, never the plan state", async () => {
    const trialPlan = `plan_trial_${nanoid(6)}`;
    const otherPlan = `plan_other_${nanoid(6)}`;
    await db.insert(plans).values([
      { id: trialPlan, name: "HTTP Test", stripePriceId: `price_t_${nanoid(6)}`, entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: 100 }, currency: "usd", interval: "month" },
      { id: otherPlan, name: "Pro", stripePriceId: `price_o_${nanoid(6)}`, entitlements: { max_agents: 10, max_printers: 25, max_jobs_per_minute: 300, max_concurrent_jobs: 16, max_prints_per_period: 1000 }, currency: "usd", interval: "month" },
    ]);
    const trialPeriodEnd = new Date(Date.now() + 27 * 24 * 3600 * 1000);
    await db.insert(tenantSubscriptions).values({
      tenantId: TENANT,
      planId: trialPlan,
      status: "trialing",
      currentPeriodEnd: trialPeriodEnd,
      trialStartedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
    });

    const started = await checkout(checkoutRequest(trialPlan));
    expect(started.status).toBe(200);

    // The operator abandons Stripe Checkout (cancel_url): no webhook ever
    // arrives for an abandoned session, so nothing may mutate the trial.
    const afterCancel = await subscriptionRow();
    expect(afterCancel?.status).toBe("trialing");
    expect(afterCancel?.planId).toBe(trialPlan);
    expect(afterCancel?.stripeSubscriptionId ?? null).toBeNull();
    expect(afterCancel?.currentPeriodEnd?.getTime()).toBe(trialPeriodEnd.getTime());

    // Only the session expires — and with it just the checkout intent opens
    // up again. The plan state is untouched; a different plan may now be
    // chosen, which is still only an INTENT until Stripe confirms.
    await db.update(tenantSubscriptions)
      .set({ checkoutSessionExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(tenantSubscriptions.tenantId, TENANT));

    const next = await checkout(checkoutRequest(otherPlan));
    expect(next.status).toBe(200);
    const nextBody = (await next.json()) as { url?: string; existing?: boolean };
    expect(nextBody.existing).toBeFalsy();

    const after = await subscriptionRow();
    expect(after?.status).toBe("trialing");
    expect(after?.planId).toBe(trialPlan); // plan identity still the trial's
    expect(after?.checkoutPlanId).toBe(otherPlan); // only the intent moved
    expect(after?.stripeSubscriptionId ?? null).toBeNull();
    expect(await subscriptionRowCount()).toBe(1);
  });
});
