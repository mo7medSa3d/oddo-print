import { logError } from "../../../../lib/log";
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

const INTERNAL_EVENT_KEY = "__yasser";

type StripeEvent = {
  id?: unknown;
  type?: unknown;
  created?: unknown;
  data?: { object?: Record<string, unknown> };
};

async function latestProcessedEventForSubscription(
  tx: { execute: typeof db.execute },
  subscriptionId: string,
): Promise<{ created: number; eventId: string } | null> {
  const result = await tx.execute(sql`
    SELECT event_id AS "eventId",
           (payload->'__yasser'->>'event_created')::bigint AS created
    FROM billing_events
    WHERE processed_at IS NOT NULL
      AND payload->'__yasser'->>'subscription_id' = ${subscriptionId}
      AND payload->'__yasser'->>'event_created' ~ '^[0-9]+$'
    ORDER BY created DESC, event_id DESC
    LIMIT 1
  `);
  const row = result.rows[0] as { created?: number | string; eventId?: string } | undefined;
  if (!row || !row.eventId || row.created === undefined) return null;
  return { created: Number(row.created), eventId: row.eventId };
}

function subscriptionIdForEvent(eventType: string, object: Record<string, unknown>): string | undefined {
  if (typeof object.subscription === "string") return object.subscription;
  if (eventType.startsWith("customer.subscription.") && typeof object.id === "string") return object.id;
  return undefined;
}

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  const secret = runtimeSecret("STRIPE_WEBHOOK_SECRET");
  if (!secret || !verifyStripeSignature(raw, sig, secret)) return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });

  let event: StripeEvent;
  try { event = JSON.parse(raw) as StripeEvent; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!eventId || !eventType) return NextResponse.json({ error: "Invalid event" }, { status: 400 });

  const obj = event.data?.object ?? {};
  const eventCreatedAt = typeof event.created === "number" ? new Date(event.created * 1000) : new Date();
  const eventCreatedUnix = Math.floor(eventCreatedAt.getTime() / 1000);
  const metadataTenantId = typeof (obj.metadata as Record<string, unknown> | undefined)?.tenant_id === "string"
    ? String((obj.metadata as Record<string, unknown>).tenant_id)
    : undefined;
  const clientReferenceTenantId = typeof obj.client_reference_id === "string" ? obj.client_reference_id : undefined;
  const candidateTenantId = metadataTenantId ?? clientReferenceTenantId;
  const customerId = typeof obj.customer === "string" ? obj.customer : undefined;
  const objectSubscriptionId = subscriptionIdForEvent(eventType, obj);

  try {
    const result = await db.transaction(async (tx) => {
      const payload = {
        ...obj,
        [INTERNAL_EVENT_KEY]: {
          event_created: eventCreatedUnix,
          subscription_id: objectSubscriptionId ?? null,
        },
      };

      const inserted = await tx.execute(sql`
        INSERT INTO billing_events (event_id, event_type, payload)
        VALUES (${eventId}, ${eventType}, ${JSON.stringify(payload)}::jsonb)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `);
      if (inserted.rows.length === 0) {
        const prior = await tx.execute(sql`
          SELECT processed_at AS "processedAt"
          FROM billing_events
          WHERE event_id = ${eventId}
          FOR UPDATE
        `);
        const priorRow = prior.rows[0] as { processedAt?: Date | string | null } | undefined;
        if (priorRow?.processedAt) return { kind: "idempotent" as const };
      }

      const identityRows = await tx.execute(sql`
        SELECT tenant_id AS "tenantId"
        FROM tenant_subscriptions
        WHERE (${objectSubscriptionId ? sql`stripe_subscription_id = ${objectSubscriptionId}` : sql`FALSE`})
           OR (${customerId ? sql`stripe_customer_id = ${customerId}` : sql`FALSE`})
        FOR UPDATE
      `);
      let boundTenantId: string | undefined;
      let billingIdentityConflict = false;
      for (const row of identityRows.rows as Array<{ tenantId?: string }>) {
        if (!row.tenantId) continue;
        if (boundTenantId && boundTenantId !== row.tenantId) billingIdentityConflict = true;
        boundTenantId ??= row.tenantId;
      }
      if (boundTenantId && candidateTenantId && boundTenantId !== candidateTenantId) billingIdentityConflict = true;
      let tenantId: string | undefined = boundTenantId ?? candidateTenantId;

      if (billingIdentityConflict) {
        await tx.update(billingEvents)
          .set({ tenantId: boundTenantId ?? null, processedAt: new Date() })
          .where(eq(billingEvents.eventId, eventId));
        if (boundTenantId) {
          await writeAuditEvent({
            tenantId: boundTenantId,
            actorType: "platform",
            actorId: "stripe",
            action: "billing.identity_conflict",
            resourceType: "billing_event",
            resourceId: eventId,
          }, tx);
        }
        return { kind: "ignored" as const };
      }

      if (eventType === "checkout.session.completed") {
        const subId = typeof obj.subscription === "string" ? obj.subscription : undefined;
        if (tenantId && subId) {
          const currentResult = await tx.execute(sql`
            SELECT stripe_subscription_id AS "stripeSubscriptionId",
                   stripe_customer_id AS "stripeCustomerId",
                   status,
                   stripe_last_event_created_at AS "stripeLastEventCreatedAt"
            FROM tenant_subscriptions
            WHERE tenant_id = ${tenantId}
            FOR UPDATE
          `);
          const current = currentResult.rows[0] as {
            stripeSubscriptionId?: string | null;
            stripeCustomerId?: string | null;
            status?: "trialing" | "active" | "past_due" | "paused" | "cancelled";
            stripeLastEventCreatedAt?: Date | null;
          } | undefined;
          const differentSubscription = Boolean(current?.stripeSubscriptionId && current.stripeSubscriptionId !== subId);
          if (differentSubscription && current?.status !== "cancelled") {
            throw new Error("Checkout subscription identity conflict");
          }
          if (differentSubscription && current?.status === "cancelled" && current.stripeLastEventCreatedAt && eventCreatedAt.getTime() < current.stripeLastEventCreatedAt.getTime()) {
            throw new Error("Stale checkout subscription identity");
          }
          if (current?.stripeCustomerId && customerId && current.stripeCustomerId !== customerId) throw new Error("Checkout customer identity conflict");
          await tx.update(tenantSubscriptions).set({
            stripeSubscriptionId: current?.stripeSubscriptionId ?? subId,
            stripeCustomerId: current?.stripeCustomerId ?? (customerId ?? null),
            updatedAt: new Date(),
          }).where(eq(tenantSubscriptions.tenantId, tenantId));
        }
      } else if (eventType.startsWith("customer.subscription.")) {
        const subId = typeof obj.id === "string" ? obj.id : "";
        const items = obj.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
        const priceId = items?.data?.[0]?.price?.id;
        const tenantRowResult = tenantId ? await tx.execute(sql`
          SELECT tenant_id AS "tenantId",
                 stripe_subscription_id AS "stripeSubscriptionId",
                 stripe_customer_id AS "stripeCustomerId",
                 status,
                 current_period_end AS "currentPeriodEnd",
                 cancel_at_period_end AS "cancelAtPeriodEnd",
                 plan_id AS "planId",
                 stripe_last_event_created_at AS "stripeLastEventCreatedAt"
          FROM tenant_subscriptions
          WHERE tenant_id = ${tenantId}
          FOR UPDATE
        `) : null;
        const tenantRow = tenantRowResult?.rows[0] as {
          tenantId?: string;
          stripeSubscriptionId?: string | null;
          stripeCustomerId?: string | null;
          status?: "trialing" | "active" | "past_due" | "paused" | "cancelled";
          currentPeriodEnd?: Date | null;
          cancelAtPeriodEnd?: boolean;
          planId?: string;
          stripeLastEventCreatedAt?: Date | null;
        } | undefined;
        const plan = priceId ? await tx.query.plans.findFirst({ where: eq(plans.stripePriceId, priceId), columns: { id: true } }) : undefined;
        if (tenantRow && tenantId) {
          const storedTime = tenantRow.stripeLastEventCreatedAt?.getTime() ?? null;
          let newerThanStored = storedTime === null || eventCreatedAt.getTime() > storedTime;
          if (storedTime !== null && eventCreatedAt.getTime() === storedTime) {
            const latest = await latestProcessedEventForSubscription(tx, subId);
            newerThanStored = Boolean(latest && latest.created === eventCreatedUnix && eventId > latest.eventId);
          }
          const differentSubscription = Boolean(tenantRow.stripeSubscriptionId && tenantRow.stripeSubscriptionId !== subId);
          if (differentSubscription && tenantRow.status !== "cancelled" ) {
            // The tenant is bound to a different live subscription. A
            // delayed event from an old/new unrelated subscription must not
            // silently steal billing identity.
            newerThanStored = false;
          }
          if (differentSubscription && tenantRow.status === "cancelled" && !newerThanStored) {
            // A cancelled tenant may legitimately start a new subscription,
            // but only an event newer than the cancellation state may replace
            // the previous subscription identity.
            newerThanStored = false;
          }
          if (newerThanStored) {
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
        }
      } else if (eventType === "invoice.paid" || eventType === "invoice.payment_failed") {
        const subId = typeof obj.subscription === "string" ? obj.subscription : undefined;
        if (subId) {
          const rowResult = await tx.execute(sql`
            SELECT tenant_id AS "tenantId"
            FROM tenant_subscriptions
            WHERE stripe_subscription_id = ${subId}
            FOR UPDATE
          `);
          const row = rowResult.rows[0] as { tenantId?: string } | undefined;
          if (row?.tenantId) {
            tenantId = row.tenantId;
            const currentResult = await tx.execute(sql`
              SELECT stripe_last_event_created_at AS "stripeLastEventCreatedAt"
              FROM tenant_subscriptions
              WHERE tenant_id = ${row.tenantId}
              FOR UPDATE
            `);
            const current = currentResult.rows[0] as { stripeLastEventCreatedAt?: Date | null } | undefined;
            const storedTime = current?.stripeLastEventCreatedAt?.getTime() ?? null;
            let newerThanStored = storedTime === null || eventCreatedAt.getTime() > storedTime;
            if (storedTime !== null && eventCreatedAt.getTime() === storedTime) {
              const latest = await latestProcessedEventForSubscription(tx, subId);
              newerThanStored = Boolean(latest && latest.created === eventCreatedUnix && eventId > latest.eventId);
            }
            if (newerThanStored) {
              await tx.update(tenantSubscriptions).set({
                status: eventType === "invoice.paid" ? "active" : "past_due",
                stripeLastEventCreatedAt: eventCreatedAt,
                updatedAt: new Date(),
              }).where(eq(tenantSubscriptions.tenantId, row.tenantId));
            }
          }
        }
      }

      await tx.update(billingEvents)
        .set({ tenantId: tenantId ?? null, processedAt: new Date() })
        .where(eq(billingEvents.eventId, eventId));

      if (tenantId) {
        await writeAuditEvent({
          tenantId,
          actorType: "platform",
          actorId: "stripe",
          action: `billing.${eventType}`,
          resourceType: "billing_event",
          resourceId: eventId,
        }, tx);
      }
      return { kind: "processed" as const, tenantId };
    });

    if (result.kind === "idempotent") return NextResponse.json({ received: true, idempotent: true });
    if (result.kind === "ignored") return NextResponse.json({ received: true, ignored: true });
    return NextResponse.json({ received: true });
  } catch (error) {
    logError("billing.webhook_failed", { eventId, error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}