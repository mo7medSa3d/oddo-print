import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { POST } from "../src/app/api/billing/webhook/route";
import { db } from "../src/db";
import { plans, tenantSubscriptions, tenants } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { hasTestDatabase, applyMigrations, truncateAll, closePool } from "./helpers/pg";
import { createHmac } from "node:crypto";
import { nanoid } from "../src/lib/nanoid";

const { stripeRetrieveMock } = vi.hoisted(() => ({ stripeRetrieveMock: vi.fn() }));
vi.mock("../src/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/stripe")>();
  return { ...actual, stripeRetrieve: stripeRetrieveMock };
});

const suite = describe.skipIf(!hasTestDatabase);
const WEBHOOK_SECRET = "whsec_test_secret_for_billing_webhook_testing_987654";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

function signPayload(payload: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const hmac = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}
function req(body: string): Request {
  return new Request("http://localhost:3000/api/billing/webhook", {
    method: "POST", headers: { "content-type": "application/json", "stripe-signature": signPayload(body) }, body,
  });
}

suite("billing incomplete_expired replacement (D-2)", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => { await truncateAll(); stripeRetrieveMock.mockReset(); });

  it("checkout.session.completed binds a new subscription over incomplete_expired", async () => {
    const tenantId = `t_${nanoid(6)}`, planId = `p_${nanoid(6)}`, price = `price_${nanoid(6)}`;
    const subOld = `sub_old_${nanoid(6)}`, subNew = `sub_new_${nanoid(6)}`, cus = `cus_${nanoid(6)}`;
    await db.insert(tenants).values({ id: tenantId, name: "T" });
    await db.insert(plans).values({
      id: planId, name: "P", stripePriceId: price, currency: "usd", interval: "month",
      entitlements: { max_agents: 1, max_printers: 1, max_jobs_per_minute: 10, max_concurrent_jobs: 1, max_prints_per_period: 10 },
    });
    await db.insert(tenantSubscriptions).values({
      tenantId, planId, status: "incomplete_expired", stripeSubscriptionId: subOld, stripeCustomerId: cus,
    });
    const now = Math.floor(Date.now() / 1000);
    stripeRetrieveMock.mockResolvedValueOnce({
      id: subNew, customer: cus, status: "active",
      items: { data: [{ price: { id: price } }] },
      current_period_start: now - 100, current_period_end: now + 3600,
    });
    const evt = JSON.stringify({
      id: `evt_${nanoid(6)}`, type: "checkout.session.completed", created: now,
      data: { object: { id: `cs_${nanoid(6)}`, customer: cus, subscription: subNew, client_reference_id: tenantId, metadata: { tenant_id: tenantId } } },
    });
    const res = await POST(req(evt));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ignored?: boolean }).ignored).toBeUndefined();
    const row = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, tenantId) });
    expect(row?.checkoutStatus).toBe("completed");
  });

  it("lifecycle created adopts a newer replacement over incomplete_expired", async () => {
    const tenantId = `t_${nanoid(6)}`, planId = `p_${nanoid(6)}`, price = `price_${nanoid(6)}`;
    const subOld = `sub_old_${nanoid(6)}`, subNew = `sub_new_${nanoid(6)}`, cus = `cus_${nanoid(6)}`;
    await db.insert(tenants).values({ id: tenantId, name: "T" });
    await db.insert(plans).values({
      id: planId, name: "P", stripePriceId: price, currency: "usd", interval: "month",
      entitlements: { max_agents: 1, max_printers: 1, max_jobs_per_minute: 10, max_concurrent_jobs: 1, max_prints_per_period: 10 },
    });
    await db.insert(tenantSubscriptions).values({
      tenantId, planId, status: "incomplete_expired", stripeSubscriptionId: subOld, stripeCustomerId: cus,
      stripeLastEventCreatedAt: new Date(Date.now() - 7200_000),
    });
    const now = Math.floor(Date.now() / 1000);
    const subObj = {
      id: subNew, customer: cus, status: "active", metadata: { tenant_id: tenantId },
      items: { data: [{ price: { id: price } }] },
      current_period_start: now - 50, current_period_end: now + 3600,
    };
    stripeRetrieveMock.mockResolvedValueOnce(subObj);
    const evt = JSON.stringify({ id: `evt_${nanoid(6)}`, type: "customer.subscription.created", created: now, data: { object: subObj } });
    const res = await POST(req(evt));
    expect(res.status).toBe(200);
    const row = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, tenantId) });
    expect(row?.stripeSubscriptionId).toBe(subNew);
    expect(row?.status).toBe("active");
  });
});
