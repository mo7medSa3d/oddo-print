import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { POST } from "../src/app/api/billing/webhook/route";
import { db } from "../src/db";
import { billingEvents, plans, tenantSubscriptions, tenants, auditEvents } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { hasTestDatabase, applyMigrations, truncateAll, closePool } from "./helpers/pg";
import { createHmac } from "node:crypto";
const { stripeRetrieveMock } = vi.hoisted(() => ({ stripeRetrieveMock: vi.fn() }));

vi.mock("../src/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/stripe")>();
  return {
    ...actual,
    stripeRetrieve: stripeRetrieveMock,
  };
});

import { nanoid } from "../src/lib/nanoid";

const suite = describe.skipIf(!hasTestDatabase);

const WEBHOOK_SECRET = "whsec_test_secret_for_billing_webhook_testing_987654";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

function signPayload(payload: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const hmac = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

function createWebhookRequest(body: string, signature?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) {
    headers["stripe-signature"] = signature;
  }
  return new Request("http://localhost:3000/api/billing/webhook", {
    method: "POST",
    headers,
    body,
  });
}

async function createPlan(id: string, name: string, stripePriceId: string) {
  await db.insert(plans).values({
    id,
    name,
    stripePriceId,
    currency: "usd",
    interval: "month",
    entitlements: { max_agents: 2, max_printers: 5, max_jobs_per_minute: 300, max_concurrent_jobs: 32, max_prints_per_period: 20 },
  });
}

async function createTenant(id: string, name = "Test Tenant") {
  await db.insert(tenants).values({ id, name });
}

async function postWebhook(body: string, signature = signPayload(body)) {
  const parsed = JSON.parse(body) as { data?: { object?: unknown } };
  stripeRetrieveMock.mockResolvedValueOnce(
    parsed.data?.object && typeof parsed.data.object === "object"
      ? parsed.data.object
      : {},
  );
  return POST(createWebhookRequest(body, signature));
}


async function createSubscription(
  tenantId: string,
  planId: string,
  stripeCustomerId: string,
  stripeSubscriptionId: string,
  status: "trialing" | "active" | "past_due" | "paused" | "cancelled" = "active",
  stripeLastEventCreatedAt?: Date
) {
  await db.insert(tenantSubscriptions).values({
    tenantId,
    planId,
    stripeCustomerId,
    stripeSubscriptionId,
    status,
    stripeLastEventCreatedAt,
  });
}

suite("Billing Webhook Route (POST /api/billing/webhook)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    stripeRetrieveMock.mockReset();
  });

  it("1. valid Stripe signature: 200 OK, event persisted in billing_events with processedAt populated, tenant subscription updated", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const customerId = `cus_${nanoid(8)}`;
    const subscriptionId = `sub_${nanoid(8)}`;
    const eventId = `evt_${nanoid(8)}`;

    await createTenant(tenantId);
    await createPlan(planId, "Starter Plan", stripePriceId);
    await createSubscription(tenantId, planId, customerId, subscriptionId, "trialing");

    const eventCreatedTs = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      created: eventCreatedTs,
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          current_period_start: eventCreatedTs - 30 * 86400,
          current_period_end: eventCreatedTs + 30 * 86400,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: stripePriceId } }] },
          metadata: { tenant_id: tenantId },
        },
      },
    });

    const sig = signPayload(payload);
    const res = await postWebhook(payload, sig);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ received: true });

    // Assert billing_events row persisted & processed
    const storedEvent = await db.query.billingEvents.findFirst({
      where: eq(billingEvents.eventId, eventId),
    });
    expect(storedEvent).toBeDefined();
    expect(storedEvent?.eventType).toBe("customer.subscription.updated");
    expect(storedEvent?.tenantId).toBe(tenantId);
    expect(storedEvent?.processedAt).toBeInstanceOf(Date);

    // Assert tenant_subscriptions row updated
    const storedSub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, tenantId),
    });
    expect(storedSub).toBeDefined();
    expect(storedSub?.status).toBe("active");
    expect(storedSub?.stripeLastEventCreatedAt?.getTime()).toBe(eventCreatedTs * 1000);
    expect(storedSub?.currentPeriodStart?.getTime()).toBe((eventCreatedTs - 30 * 86400) * 1000);
    expect(storedSub?.currentPeriodEnd?.getTime()).toBe((eventCreatedTs + 30 * 86400) * 1000);

    // Assert audit event recorded
    const auditLogs = await db.query.auditEvents.findMany({
      where: eq(auditEvents.tenantId, tenantId),
    });
    expect(auditLogs.some((a) => a.action === "billing.customer.subscription.updated" && a.resourceId === eventId)).toBe(true);
  });


  it("1b. preserves the stored period start when Stripe omits current_period_start", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const customerId = `cus_${nanoid(8)}`;
    const subscriptionId = `sub_${nanoid(8)}`;
    const eventId = `evt_${nanoid(8)}`;

    await createTenant(tenantId);
    await createPlan(planId, "Fallback Period Plan", stripePriceId);
    await createSubscription(tenantId, planId, customerId, subscriptionId, "active");

    const before = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, tenantId),
    });
    expect(before?.currentPeriodStart).toBeInstanceOf(Date);

    const eventCreatedTs = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      created: eventCreatedTs,
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          current_period_end: eventCreatedTs + 30 * 86400,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: stripePriceId } }] },
          metadata: { tenant_id: tenantId },
        },
      },
    });

    const res = await postWebhook(payload);
    expect(res.status).toBe(200);

    const after = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, tenantId),
    });
    expect(after?.currentPeriodStart?.getTime()).toBe(before?.currentPeriodStart?.getTime());
    expect(after?.currentPeriodEnd?.getTime()).toBe((eventCreatedTs + 30 * 86400) * 1000);
  });
  it("repeated processed subscription events are acknowledged without another Stripe retrieval", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const customerId = `cus_${nanoid(8)}`;
    const subscriptionId = `sub_${nanoid(8)}`;
    const eventId = `evt_duplicate_fast_path_${nanoid(8)}`;

    await createTenant(tenantId);
    await createPlan(planId, "Starter Plan", stripePriceId);
    await createSubscription(tenantId, planId, customerId, subscriptionId, "trialing");

    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          items: { data: [{ price: { id: stripePriceId } }] },
          metadata: { tenant_id: tenantId },
        },
      },
    });
    const signature = signPayload(payload);

    stripeRetrieveMock.mockResolvedValueOnce({
      id: subscriptionId,
      object: "subscription",
      customer: customerId,
      status: "active",
      items: { data: [{ price: { id: stripePriceId } }] },
      metadata: { tenant_id: tenantId },
      current_period_end: Math.floor(Date.now() / 1000) + 3600,
      cancel_at_period_end: false,
    });

    const first = await POST(createWebhookRequest(payload, signature));
    expect(first.status).toBe(200);
    expect(stripeRetrieveMock).toHaveBeenCalledTimes(1);

    stripeRetrieveMock.mockRejectedValueOnce(new Error("Stripe temporarily unavailable"));
    const second = await POST(createWebhookRequest(payload, signature));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, idempotent: true });
    expect(stripeRetrieveMock).toHaveBeenCalledTimes(1);
  });
  it("2. invalid Stripe signature: 400 Bad Request, no database mutation", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const customerId = `cus_${nanoid(8)}`;
    const subscriptionId = `sub_${nanoid(8)}`;
    const eventId = `evt_${nanoid(8)}`;

    await createTenant(tenantId);
    await createPlan(planId, "Starter Plan", stripePriceId);
    await createSubscription(tenantId, planId, customerId, subscriptionId, "trialing");

    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          metadata: { tenant_id: tenantId },
        },
      },
    });

    const invalidSig = "t=1234567890,v1=deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd";
    const req = createWebhookRequest(payload, invalidSig);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "Invalid webhook signature" });

    // Assert no mutations
    const events = await db.query.billingEvents.findMany();
    expect(events.length).toBe(0);

    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, tenantId),
    });
    expect(sub?.status).toBe("trialing");
  });

  it("3. missing Stripe signature: 400 Bad Request, no database mutation", async () => {
    const eventId = `evt_${nanoid(8)}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      data: { object: {} },
    });

    const req = createWebhookRequest(payload); // No signature header
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "Invalid webhook signature" });

    const events = await db.query.billingEvents.findMany();
    expect(events.length).toBe(0);
  });

  it("4. duplicate event delivery: first delivery returns 200, second delivery returns 200 { received: true, idempotent: true } without duplicate mutations or audit logs", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const customerId = `cus_${nanoid(8)}`;
    const subscriptionId = `sub_${nanoid(8)}`;
    const eventId = `evt_${nanoid(8)}`;

    await createTenant(tenantId);
    await createPlan(planId, "Starter Plan", stripePriceId);
    await createSubscription(tenantId, planId, customerId, subscriptionId, "trialing");

    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          items: { data: [{ price: { id: stripePriceId } }] },
          metadata: { tenant_id: tenantId },
        },
      },
    });

    const sig = signPayload(payload);

    // 1st delivery
    const res1 = await postWebhook(payload, sig);
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ received: true });

    const auditCountBefore = (await db.query.auditEvents.findMany({ where: eq(auditEvents.tenantId, tenantId) })).length;
    expect(auditCountBefore).toBe(1);

    // 2nd delivery with identical event_id
    const req2 = createWebhookRequest(payload, sig);
    const res2 = await POST(req2);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ received: true, idempotent: true });

    const auditCountAfter = (await db.query.auditEvents.findMany({ where: eq(auditEvents.tenantId, tenantId) })).length;
    expect(auditCountAfter).toBe(1); // No new audit log

    const allEvents = await db.query.billingEvents.findMany({ where: eq(billingEvents.eventId, eventId) });
    expect(allEvents.length).toBe(1);
  });

  it("5. out-of-order event delivery: an older event does not regress subscription status or timestamp", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const customerId = `cus_${nanoid(8)}`;
    const subscriptionId = `sub_${nanoid(8)}`;

    await createTenant(tenantId);
    await createPlan(planId, "Starter Plan", stripePriceId);

    // Sub state already has a newer event at T = 2026-06-15T12:00:00Z (timestamp 1781524800)
    const newerDate = new Date("2026-06-15T12:00:00Z");
    await createSubscription(tenantId, planId, customerId, subscriptionId, "active", newerDate);

    // Older event with T = 2026-06-10T12:00:00Z (timestamp 1781092800) with status 'past_due'
    const olderTs = Math.floor(new Date("2026-06-10T12:00:00Z").getTime() / 1000);
    const eventId = `evt_older_${nanoid(8)}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      created: olderTs,
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "past_due",
          items: { data: [{ price: { id: stripePriceId } }] },
          metadata: { tenant_id: tenantId },
        },
      },
    });

    const sig = signPayload(payload);
    stripeRetrieveMock.mockResolvedValueOnce({
      id: subscriptionId,
      object: "subscription",
      customer: customerId,
      status: "active",
      items: { data: [{ price: { id: stripePriceId } }] },
      metadata: { tenant_id: tenantId },
      current_period_end: Math.floor(Date.now() / 1000) + 3600,
      cancel_at_period_end: false,
    });
    const res = await POST(createWebhookRequest(payload, sig));

    expect(res.status).toBe(200);

    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, tenantId),
    });
    // Subscription status MUST NOT regress to 'past_due'
    expect(sub?.status).toBe("active");
    expect(sub?.stripeLastEventCreatedAt?.toISOString()).toBe(newerDate.toISOString());

    // Event is still recorded as processed
    const storedEvent = await db.query.billingEvents.findFirst({
      where: eq(billingEvents.eventId, eventId),
    });
    expect(storedEvent?.processedAt).toBeInstanceOf(Date);
  });

  it("6. status mapping: correctly maps Stripe subscription statuses", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const customerId = `cus_${nanoid(8)}`;
    const subscriptionId = `sub_${nanoid(8)}`;

    await createTenant(tenantId);
    await createPlan(planId, "Starter Plan", stripePriceId);
    await createSubscription(tenantId, planId, customerId, subscriptionId, "trialing");

    const statusMappings: Array<{ stripeStatus: string; expectedDbStatus: "trialing" | "active" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "paused" | "cancelled" }> = [
      { stripeStatus: "trialing", expectedDbStatus: "trialing" },
      { stripeStatus: "active", expectedDbStatus: "active" },
      { stripeStatus: "past_due", expectedDbStatus: "past_due" },
      { stripeStatus: "unpaid", expectedDbStatus: "unpaid" },
      { stripeStatus: "paused", expectedDbStatus: "paused" },
      { stripeStatus: "incomplete", expectedDbStatus: "incomplete" },
      { stripeStatus: "incomplete_expired", expectedDbStatus: "incomplete_expired" },
      { stripeStatus: "canceled", expectedDbStatus: "cancelled" },
      { stripeStatus: "cancelled", expectedDbStatus: "cancelled" },
    ];

    let baseTime = Math.floor(Date.now() / 1000);

    for (const { stripeStatus, expectedDbStatus } of statusMappings) {
      baseTime += 10;
      const eventId = `evt_status_${stripeStatus}_${nanoid(6)}`;
      const payload = JSON.stringify({
        id: eventId,
        type: "customer.subscription.updated",
        created: baseTime,
        data: {
          object: {
            id: subscriptionId,
            customer: customerId,
            status: stripeStatus,
            items: { data: [{ price: { id: stripePriceId } }] },
            metadata: { tenant_id: tenantId },
          },
        },
      });

      const res = await postWebhook(payload, signPayload(payload));
      expect(res.status).toBe(200);

      const sub = await db.query.tenantSubscriptions.findFirst({
        where: eq(tenantSubscriptions.tenantId, tenantId),
      });
      expect(sub?.status).toBe(expectedDbStatus);
    }
  });

  it("7. invoice paid event: records the payment fact without overriding subscription lifecycle state", async () => {
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const customerId = `cus_${nanoid(8)}`;
    const subscriptionId = `sub_${nanoid(8)}`;
    const eventId = `evt_inv_paid_${nanoid(8)}`;

    await createTenant(tenantId);
    await createPlan(planId, "Starter Plan", stripePriceId);
    await createSubscription(tenantId, planId, customerId, subscriptionId, "past_due");

    const payload = JSON.stringify({
      id: eventId,
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          subscription: subscriptionId,
          customer: customerId,
        },
      },
    });

    const res = await postWebhook(payload, signPayload(payload));
    expect(res.status).toBe(200);

    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, tenantId),
    });
    expect(sub?.status).toBe("past_due");

    const storedEvent = await db.query.billingEvents.findFirst({
      where: eq(billingEvents.eventId, eventId),
    });
    expect(storedEvent?.processedAt).toBeInstanceOf(Date);
  });

  it("8. invoice payment failed event: records the payment fact without overriding subscription lifecycle state or other tenants", async () => {
    const tenantA = `tenant_a_${nanoid(8)}`;
    const tenantB = `tenant_b_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const subA = `sub_a_${nanoid(8)}`;
    const subB = `sub_b_${nanoid(8)}`;
    const eventId = `evt_inv_fail_${nanoid(8)}`;

    await createTenant(tenantA, "Tenant A");
    await createTenant(tenantB, "Tenant B");
    await createPlan(planId, "Plan", stripePriceId);
    await createSubscription(tenantA, planId, `cus_a_${nanoid(6)}`, subA, "active");
    await createSubscription(tenantB, planId, `cus_b_${nanoid(6)}`, subB, "active");

    const payload = JSON.stringify({
      id: eventId,
      type: "invoice.payment_failed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          subscription: subA,
        },
      },
    });

    const res = await postWebhook(payload, signPayload(payload));
    expect(res.status).toBe(200);

    // Tenant A remains active; subscription lifecycle events are authoritative.
    const storedA = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, tenantA),
    });
    expect(storedA?.status).toBe("active");

    // Tenant B remains active
    const storedB = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, tenantB),
    });
    expect(storedB?.status).toBe("active");
  });

  it("9. unknown tenant: valid Stripe webhook for unknown tenant records event with tenant_id: null, returns 200, without corrupting tenants", async () => {
    const existingTenant = `tenant_exist_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const existingSub = `sub_exist_${nanoid(8)}`;
    const eventId = `evt_unknown_${nanoid(8)}`;

    await createTenant(existingTenant, "Existing Tenant");
    await createPlan(planId, "Plan", stripePriceId);
    await createSubscription(existingTenant, planId, `cus_exist_${nanoid(6)}`, existingSub, "active");

    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "sub_unregistered_9999",
          customer: "cus_unregistered_9999",
          status: "past_due",
        },
      },
    });

    const res = await postWebhook(payload, signPayload(payload));
    expect(res.status).toBe(200);

    // Event persisted with null tenant_id
    const storedEvent = await db.query.billingEvents.findFirst({
      where: eq(billingEvents.eventId, eventId),
    });
    expect(storedEvent).toBeDefined();
    expect(storedEvent?.tenantId).toBeNull();
    expect(storedEvent?.processedAt).toBeInstanceOf(Date);

    // Existing tenant is unaffected
    const storedSub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, existingTenant),
    });
    expect(storedSub?.status).toBe("active");
  });

  it("10. transactional / malformed event handling: malformed JSON or missing required fields returns 400 without committing false processed state", async () => {
    // 10a: Malformed JSON body
    const badJson = "{\"id\": \"evt_malformed\", \"type\":";
    const sig1 = signPayload(badJson);
    const res1 = await POST(createWebhookRequest(badJson, sig1));
    expect(res1.status).toBe(400);
    const json1 = await res1.json();
    expect(json1).toEqual({ error: "Invalid JSON" });

    // 10b: Missing event ID or type
    const missingFields = JSON.stringify({ data: { object: {} } });
    const sig2 = signPayload(missingFields);
    const res2 = await POST(createWebhookRequest(missingFields, sig2));
    expect(res2.status).toBe(400);
    const json2 = await res2.json();
    expect(json2).toEqual({ error: "Invalid event" });

    // Verify no events were recorded in billing_events
    const count = await db.query.billingEvents.findMany();
    expect(count.length).toBe(0);
  });

  it("11. checkout customer identity conflict: poison event is acked (200, ignored), marked processed, audited, and never 500s into a Stripe retry loop", async () => {
    // Regression: this shape used to throw "Checkout customer identity
    // conflict" -> 500 -> Stripe retries forever (a single poison event
    // could get the endpoint auto-disabled for every tenant).
    const tenantId = `tenant_${nanoid(8)}`;
    const planId = `plan_${nanoid(8)}`;
    const stripePriceId = `price_${nanoid(8)}`;
    const boundCustomerId = `cus_bound_${nanoid(6)}`;
    const foreignCustomerId = `cus_other_${nanoid(6)}`;
    const subscriptionId = `sub_${nanoid(8)}`;
    const eventId = `evt_conflict_${nanoid(8)}`;

    await createTenant(tenantId);
    await createPlan(planId, "Starter Plan", stripePriceId);
    await createSubscription(tenantId, planId, boundCustomerId, subscriptionId, "active");

    const eventCreatedTs = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      created: eventCreatedTs,
      data: {
        object: {
          id: `cs_${nanoid(10)}`,
          customer: foreignCustomerId,
          subscription: subscriptionId,
          metadata: { tenant_id: tenantId },
        },
      },
    });
    const res = await postWebhook(payload, signPayload(payload));
    // Acknowledged, not 500: Stripe must not retry.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ received: true, ignored: true });

    // The event is recorded as processed so replays stay idempotent.
    const storedEvent = await db.query.billingEvents.findFirst({
      where: eq(billingEvents.eventId, eventId),
    });
    expect(storedEvent?.processedAt).not.toBeNull();
    expect(storedEvent?.tenantId).toBe(tenantId);

    // The bound billing identity is untouched.
    const storedSub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, tenantId),
    });
    expect(storedSub?.stripeCustomerId).toBe(boundCustomerId);
    expect(storedSub?.status).toBe("active");
    expect(storedSub?.checkoutStatus).toBe("none");

    // Operator-visible audit trail.
    const audits = await db.query.auditEvents.findMany({
      where: eq(auditEvents.resourceId, eventId),
    });
    expect(audits.some((a) => a.action === "billing.checkout_customer_conflict")).toBe(true);
  });
});
