import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { billingEvents, plans, tenantSubscriptions } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { verifyStripeSignature } from "../../../../lib/stripe";
import { writeAuditEvent } from "../../../../lib/audit";

function statusOf(status: string): "trialing" | "active" | "past_due" | "paused" | "cancelled" {
  if (status === "trialing") return "trialing";
  if (status === "active") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "paused" || status === "incomplete") return "paused";
  return "cancelled";
}

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  const secret = runtimeSecret("STRIPE_WEBHOOK_SECRET");
  if (!secret || !verifyStripeSignature(raw, sig, secret)) return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });

  let event: { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown> } };
  try { event = JSON.parse(raw) as typeof event; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!eventId || !eventType) return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  const obj = event.data?.object ?? {};
  const eventCreatedAt = typeof (event as { created?: unknown }).created === "number" ? new Date((event as { created: number }).created * 1000) : new Date();

  const inserted = await db.execute(sql`
    INSERT INTO billing_events (event_id, event_type, payload)
    VALUES (${eventId}, ${eventType}, ${JSON.stringify(obj)}::jsonb)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `);
  if (inserted.rows.length === 0) {
    const prior = await db.query.billingEvents.findFirst({ where: eq(billingEvents.eventId, eventId), columns: { processedAt: true } });
    if (prior?.processedAt) return NextResponse.json({ received: true, idempotent: true });
  }

  let tenantId: string | undefined = typeof (obj.metadata as Record<string, unknown> | undefined)?.tenant_id === "string" ? (obj.metadata as Record<string, unknown>).tenant_id as string : undefined;
  if (!tenantId && typeof obj.client_reference_id === "string") tenantId = obj.client_reference_id;
  if (!tenantId && typeof obj.customer === "string") {
    const row = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.stripeCustomerId, obj.customer), columns: { tenantId: true } });
    tenantId = row?.tenantId;
  }

  try {
    await db.transaction(async (tx) => {
      if (eventType === "checkout.session.completed") {
        const subId = typeof obj.subscription === "string" ? obj.subscription : undefined;
        if (tenantId && subId) {
          const current = await tx.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, tenantId), columns: { stripeSubscriptionId: true, stripeCustomerId: true } });
          await tx.update(tenantSubscriptions).set({ stripeSubscriptionId: current?.stripeSubscriptionId ?? subId, stripeCustomerId: current?.stripeCustomerId ?? (typeof obj.customer === "string" ? obj.customer : null), updatedAt: new Date() }).where(eq(tenantSubscriptions.tenantId, tenantId));
        }
      } else if (eventType.startsWith("customer.subscription.")) {
        const subId = typeof obj.id === "string" ? obj.id : "";
        const items = obj.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
        const priceId = items?.data?.[0]?.price?.id;
        const tenantRow = tenantId ? await tx.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, tenantId) }) : undefined;
        const plan = priceId ? await tx.query.plans.findFirst({ where: eq(plans.stripePriceId, priceId), columns: { id: true } }) : undefined;
        const newerThanStored = !tenantRow?.stripeLastEventCreatedAt || tenantRow.stripeLastEventCreatedAt.getTime() <= eventCreatedAt.getTime();
        if (tenantRow && tenantId && newerThanStored) {
          await tx.update(tenantSubscriptions).set({
            stripeCustomerId: typeof obj.customer === "string" ? obj.customer : tenantRow.stripeCustomerId,
            stripeSubscriptionId: subId || tenantRow.stripeSubscriptionId,
            status: typeof obj.status === "string" ? statusOf(obj.status) : tenantRow.status,
            currentPeriodEnd: typeof obj.current_period_end === "number" ? new Date(obj.current_period_end * 1000) : tenantRow.currentPeriodEnd,
            cancelAtPeriodEnd: obj.cancel_at_period_end === true,
            planId: plan?.id ?? tenantRow.planId,
            stripeLastEventCreatedAt: eventCreatedAt,
            updatedAt: new Date(),
          }).where(eq(tenantSubscriptions.tenantId, tenantId));
        }
      } else if (eventType === "invoice.paid" || eventType === "invoice.payment_failed") {
        const subId = typeof obj.subscription === "string" ? obj.subscription : undefined;
        if (subId) {
          const row = await tx.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.stripeSubscriptionId, subId), columns: { tenantId: true } });
          if (row) {
            tenantId = row.tenantId;
            const current = await tx.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, row.tenantId), columns: { stripeLastEventCreatedAt: true } });
            const newerThanStored = !current?.stripeLastEventCreatedAt || current.stripeLastEventCreatedAt.getTime() <= eventCreatedAt.getTime();
            if (newerThanStored) {
              await tx.update(tenantSubscriptions).set({ status: eventType === "invoice.paid" ? "active" : "past_due", stripeLastEventCreatedAt: eventCreatedAt, updatedAt: new Date() }).where(eq(tenantSubscriptions.tenantId, row.tenantId));
            }
          }
        }
      }
      await tx.update(billingEvents).set({ tenantId: tenantId ?? null, processedAt: new Date() }).where(eq(billingEvents.eventId, eventId));
    });
    if (tenantId) await writeAuditEvent({ tenantId, actorType: "platform", actorId: "stripe", action: `billing.${eventType}`, resourceType: "billing_event", resourceId: eventId }).catch(() => undefined);
    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
