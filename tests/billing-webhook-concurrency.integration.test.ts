import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { POST } from "../src/app/api/billing/webhook/route";
import { db } from "../src/db";
import { auditEvents, billingEvents, plans, tenantSubscriptions, tenants } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { applyMigrations, closePool, hasTestDatabase, truncateAll } from "./helpers/pg";
const { stripeRetrieveMock } = vi.hoisted(() => ({ stripeRetrieveMock: vi.fn() }));

vi.mock("../src/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/stripe")>();
  return {
    ...actual,
    stripeRetrieve: stripeRetrieveMock,
  };
});

stripeRetrieveMock.mockImplementation(async (path: string) => ({
  id: decodeURIComponent(path.split("/").pop() ?? ""),
  object: "subscription",
  status: "active",
  items: { data: [] },
  metadata: {},
}));

import { nanoid } from "../src/lib/nanoid";

const suite = describe.skipIf(!hasTestDatabase);
const WEBHOOK_SECRET = "whsec_test_concurrency_secret_123456789";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

function signPayload(payload: string, timestamp: number): string {
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function requestFor(payload: string, timestamp: number): Request {
  return new Request("http://localhost:3000/api/billing/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signPayload(payload, timestamp),
    },
    body: payload,
  });
}

suite("billing webhook concurrency", () => {
  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => { await truncateAll(); stripeRetrieveMock.mockClear(); });
  afterAll(async () => { await closePool(); });

  async function seed() {
    const tenantId = `tenant_billing_concurrency_${nanoid(8)}`;
    const planId = `plan_billing_concurrency_${nanoid(8)}`;
    const priceId = `price_billing_concurrency_${nanoid(8)}`;
    const customerId = `cus_${nanoid(8)}`;
    const subscriptionId = `sub_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Billing Concurrency Test" });
    await db.insert(plans).values({ id: planId, name: `Plan ${nanoid(6)}`, stripePriceId: priceId, currency: "usd", interval: "month", entitlements: { maxPrinters: 5 } });
    await db.insert(tenantSubscriptions).values({ tenantId, planId, stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId, status: "trialing" });
    return { tenantId, customerId, subscriptionId, priceId };
  }

  function subscriptionPayload(eventId: string, created: number, seeded: Awaited<ReturnType<typeof seed>>, status: string) {
    return JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      created,
      data: { object: {
        id: seeded.subscriptionId,
        customer: seeded.customerId,
        status,
        items: { data: [{ price: { id: seeded.priceId } }] },
        metadata: { tenant_id: seeded.tenantId },
      } },
    });
  }

  it("serializes duplicate delivery so only one request processes and one is idempotent", async () => {
    const seeded = await seed();
    const created = Math.floor(Date.now() / 1000);
    const eventId = `evt_duplicate_${nanoid(10)}`;
    const payload = subscriptionPayload(eventId, created, seeded, "active");

    const [r1, r2] = await Promise.all([POST(requestFor(payload, created)), POST(requestFor(payload, created))]);
    const bodies = await Promise.all([r1.json(), r2.json()]);
    expect([r1.status, r2.status].sort()).toEqual([200, 200]);
    expect(bodies.filter((body) => body.idempotent === true)).toHaveLength(1);
    expect(bodies.filter((body) => body.received === true && body.idempotent !== true)).toHaveLength(1);

    const stored = await db.query.billingEvents.findMany({ where: eq(billingEvents.eventId, eventId) });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.processedAt).toBeInstanceOf(Date);

    const audits = await db.query.auditEvents.findMany({ where: eq(auditEvents.tenantId, seeded.tenantId) });
    expect(audits.filter((row) => row.action === "billing.customer.subscription.updated")).toHaveLength(1);

    const subscription = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, seeded.tenantId) });
    expect(subscription?.status).toBe("active");
  });

  it("serializes first checkout identity binding and ignores a concurrent conflicting subscription", async () => {
    const seeded = await seed();
    await db.update(tenantSubscriptions).set({
      stripeSubscriptionId: null,
      stripeCustomerId: null,
    }).where(eq(tenantSubscriptions.tenantId, seeded.tenantId));

    const created = Math.floor(Date.now() / 1000);
    const firstSubscriptionId = `sub_first_${nanoid(8)}`;
    const secondSubscriptionId = `sub_second_${nanoid(8)}`;
    const base = (eventId: string, subId: string) => JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      created,
      data: { object: {
        subscription: subId,
        customer: seeded.customerId,
        client_reference_id: seeded.tenantId,
        metadata: { tenant_id: seeded.tenantId },
      } },
    });

    const [r1, r2] = await Promise.all([
      POST(requestFor(base(`evt_checkout_a_${nanoid(6)}`, firstSubscriptionId), created)),
      POST(requestFor(base(`evt_checkout_b_${nanoid(6)}`, secondSubscriptionId), created)),
    ]);

    expect([r1.status, r2.status].sort()).toEqual([200, 200]);
    const subscription = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, seeded.tenantId),
    });
    expect([firstSubscriptionId, secondSubscriptionId]).toContain(subscription?.stripeSubscriptionId);
    expect(subscription?.stripeCustomerId).toBe(seeded.customerId);
  });

  it("rebinds a cancelled tenant to the new Stripe subscription on checkout completion", async () => {
    const seeded = await seed();
    const cancelledAt = Math.floor(Date.now() / 1000) - 60;
    await db.update(tenantSubscriptions)
      .set({ status: "cancelled", stripeLastEventCreatedAt: new Date(cancelledAt * 1000) })
      .where(eq(tenantSubscriptions.tenantId, seeded.tenantId));

    const newSubscriptionId = `sub_checkout_new_${nanoid(8)}`;
    const created = cancelledAt + 30;
    const payload = JSON.stringify({
      id: `evt_checkout_rebind_${nanoid(8)}`,
      type: "checkout.session.completed",
      created,
      data: { object: {
        subscription: newSubscriptionId,
        customer: seeded.customerId,
        client_reference_id: seeded.tenantId,
        metadata: { tenant_id: seeded.tenantId },
      } },
    });

    const res = await POST(requestFor(payload, created));
    expect(res.status).toBe(200);

    const subscription = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, seeded.tenantId),
    });
    expect(subscription?.stripeSubscriptionId).toBe(newSubscriptionId);
    expect(subscription?.status).toBe("cancelled");
  });

  it("does not let an older subscription identity steal a tenant from its current subscription", async () => {
    const seeded = await seed();
    const currentCreated = Math.floor(Date.now() / 1000);
    await db.update(tenantSubscriptions)
      .set({ status: "active", stripeLastEventCreatedAt: new Date(currentCreated * 1000) })
      .where(eq(tenantSubscriptions.tenantId, seeded.tenantId));

    const oldSubscriptionId = `sub_old_${nanoid(8)}`;
    const stalePayload = JSON.stringify({
      id: `evt_stale_identity_${nanoid(8)}`,
      type: "customer.subscription.updated",
      created: currentCreated - 30,
      data: { object: {
        id: oldSubscriptionId,
        customer: seeded.customerId,
        status: "past_due",
        metadata: { tenant_id: seeded.tenantId },
      } },
    });

    const res = await POST(requestFor(stalePayload, currentCreated - 30));
    expect(res.status).toBe(200);

    const subscription = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, seeded.tenantId),
    });
    expect(subscription?.stripeSubscriptionId).toBe(seeded.subscriptionId);
    expect(subscription?.status).toBe("active");
  });

  it("allows a newer subscription event to replace a cancelled subscription identity", async () => {
    const seeded = await seed();
    const cancelledAt = Math.floor(Date.now() / 1000) - 60;
    await db.update(tenantSubscriptions)
      .set({ status: "cancelled", stripeLastEventCreatedAt: new Date(cancelledAt * 1000) })
      .where(eq(tenantSubscriptions.tenantId, seeded.tenantId));

    const newSubscriptionId = `sub_new_${nanoid(8)}`;
    const created = cancelledAt + 30;
    const payload = JSON.stringify({
      id: `evt_new_identity_${nanoid(8)}`,
      type: "customer.subscription.updated",
      created,
      data: { object: {
        id: newSubscriptionId,
        customer: seeded.customerId,
        status: "active",
        items: { data: [{ price: { id: seeded.priceId } }] },
        metadata: { tenant_id: seeded.tenantId },
      } },
    });

    const res = await POST(requestFor(payload, created));
    expect(res.status).toBe(200);

    const subscription = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, seeded.tenantId),
    });
    expect(subscription?.stripeSubscriptionId).toBe(newSubscriptionId);
    expect(subscription?.status).toBe("active");
    expect(subscription?.stripeLastEventCreatedAt?.getTime()).toBe(created * 1000);
  });

  it("uses the current Stripe subscription snapshot when events share a created timestamp", async () => {
    const seeded = await seed();
    const created = Math.floor(Date.now() / 1000);
    const lowerId = "evt_same_second_a";
    const higherId = "evt_same_second_b";
    const olderByTiePayload = subscriptionPayload(lowerId, created, seeded, "past_due");
    const newerByTiePayload = subscriptionPayload(higherId, created, seeded, "active");

    await POST(requestFor(newerByTiePayload, created));
    await POST(requestFor(olderByTiePayload, created));

    const subscription = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, seeded.tenantId) });
    expect(subscription?.status).toBe("active");
    expect(subscription?.stripeLastEventCreatedAt?.getTime()).toBe(created * 1000);
  });
});