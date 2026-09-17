import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { plans, tenantSubscriptions, tenants } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { stripeRequest } from "../../../../lib/stripe";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { sql } from "drizzle-orm";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  const claims = await validateManager(req);
  if (!claims || !claims.userId || !hasManagerPermission(claims, "billing.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { planId?: unknown } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  if (!plan?.stripePriceId) return NextResponse.json({ error: "Plan is not billable" }, { status: 400 });
  const stripePriceId = plan.stripePriceId;

  const result = await db.transaction(async (tx) => {
    // Serialize checkout state transitions per tenant. The same lock covers
    // customer binding and local subscription creation/update, so concurrent
    // requests cannot both observe an unbound tenant and create independent
    // local identities. Stripe calls use deterministic idempotency keys as the
    // external side-effect fence.
    const tenant = await tx.execute(sql`
      SELECT id, lifecycle
      FROM tenants
      WHERE id = ${claims.tenantId}
      FOR UPDATE
    `);
    const tenantRow = tenant.rows[0] as { id?: string; lifecycle?: string } | undefined;
    if (!tenantRow?.id) throw new Error("TENANT_NOT_FOUND");
    if (tenantRow.lifecycle !== "active") throw new Error("TENANT_NOT_ACTIVE");

    let sub = await tx.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, claims.tenantId),
    });
    if (sub?.stripeSubscriptionId && ["trialing", "active", "past_due", "paused"].includes(sub.status)) {
      return { kind: "already_subscribed" as const };
    }

    let customerId = sub?.stripeCustomerId ?? null;
    if (!customerId) {
      const params = new URLSearchParams({
        description: `Print Gateway tenant ${claims.tenantId}`,
        "metadata[tenant_id]": claims.tenantId,
      });
      const customer = await stripeRequest("customers", params, `tenant-customer-${claims.tenantId}`);
      customerId = customer.id;

      if (sub) {
        await tx.update(tenantSubscriptions)
          .set({ stripeCustomerId: customerId, updatedAt: new Date() })
          .where(eq(tenantSubscriptions.tenantId, claims.tenantId));
      } else {
        await tx.insert(tenantSubscriptions).values({
          tenantId: claims.tenantId,
          planId: plan.id,
          status: "cancelled",
          stripeCustomerId: customerId,
        });
      }
      sub = await tx.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, claims.tenantId) });
    }

    if (!customerId) throw new Error("CUSTOMER_ID_MISSING");
    const base = (runtimeSecret("APP_BASE_URL") ?? new URL(req.url).origin).replace(/\/$/, "");
    const params = new URLSearchParams({
      mode: "subscription",
      customer: customerId,
      client_reference_id: claims.tenantId,
      success_url: `${base}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/billing?checkout=cancelled`,
      "line_items[0][price]": stripePriceId,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][tenant_id]": claims.tenantId,
      "subscription_data[metadata][plan_id]": plan.id,
    });
    const session = await stripeRequest("checkout/sessions", params, `checkout-${claims.tenantId}-${plan.id}`);
    return { kind: "created" as const, url: session.url };
  });

  if (result.kind === "already_subscribed") {
    return NextResponse.json({ error: "This workspace already has a Stripe subscription. Use the Customer Portal to change plans." }, { status: 409 });
  }
  return NextResponse.json({ ok: true, url: result.url });
}
