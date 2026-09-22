import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { billingEvents, plans, tenantSubscriptions } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { stripeRetrieve, verifyStripeSignature } from "../../../../lib/stripe";
import { writeAuditEvent } from "../../../../lib/audit";
import { hasBodyOverLimit } from "../../../../lib/request-limits";

function statusOf(status: string): "trialing" | "active" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "paused" | "cancelled" {
  if (status === "trialing") return "trialing";
  if (status === "active") return "active";
  if (status === "past_due") return "past_due";
  if (status === "incomplete") return "incomplete";
  if (status === "incomplete_expired") return "incomplete_expired";
  if (status === "unpaid") return "unpaid";
  if (status === "paused") return "paused";
  return "cancelled";
}

const INTERNAL_EVENT_KEY = "__yasser";

/**
 * Raw `db.execute()` rows surface naive UTC timestamp strings (node-postgres
 * identity parsers for timestamp OIDs) while typed drizzle rows surface Date.
 * Normalize either form to epoch milliseconds without host-TZ dependence.
 */
function parseDbTimeMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const text = value.trim();
  if (!text) return null;
  let iso = text.replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) {
    iso += /[+-]\d{2}$/.test(iso) ? ":00" : "Z";
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function parseDbTime(value: Date | string | null | undefined): Date | null {
  const ms = parseDbTimeMs(value);
  return ms === null ? null : new Date(ms);
}

type StripeEvent = {
  id?: unknown;
  type?: unknown;
  created?: unknown;
  data?: { object?: Record<string, unknown> };
};

function subscriptionIdForEvent(eventType: string, object: Record<string, unknown>): string | undefined {
  if (typeof object.subscription === "string") return object.subscription;
  if (eventType.startsWith("customer.subscription.") && typeof object.id === "string") return object.id;
  return undefined;
}

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 2 * 1024 * 1024)) {
    return NextResponse.json({ error: "Webhook payload too large" }, { status: 413 });
  }
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  const secret = runtimeSecret("STRIPE_WEBHOOK_SECRET");
  if (!secret || !verifyStripeSignature(raw, sig, secret)) return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });

  let event: StripeEvent;
  try { event = JSON.parse(raw) as StripeEvent; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!eventId || !eventType) return NextResponse.json({ error: "Invalid event" }, { status: 400 });

  // Duplicate deliveries are normal. Once an event is durably processed,
  // acknowledge it without depending on Stripe API availability. The
  // transaction-level idempotency check below remains the race-safe fence
  // for concurrent in-flight duplicates.
  const priorEvent = await db.query.billingEvents.findFirst({
    where: eq(billingEvents.eventId, eventId),
    columns: { processedAt: true },
  });
  if (priorEvent?.processedAt) {
    return NextResponse.json({ received: true, idempotent: true });
  }

  // Keep the immutable event snapshot for audit/idempotency, but use a
  // separately retrieved current Stripe resource when subscription state
  // depends on it. Stripe explicitly does not guarantee webhook ordering and
  // snapshot event timestamps are only second-resolution.
  const obj = event.data?.object ?? {};
  const eventCreatedAt = typeof event.created === "number" ? new Date(event.created * 1000) : new Date();
  const eventCreatedUnix = Math.floor(eventCreatedAt.getTime() / 1000);

  let stateObj: Record<string, unknown> = obj;
  if (eventType === "customer.subscription.created" || eventType === "customer.subscription.updated") {
    const subscriptionId = typeof obj.id === "string" ? obj.id : "";
    if (!subscriptionId) return NextResponse.json({ error: "Subscription event missing subscription id" }, { status: 400 });
    try {
      stateObj = await stripeRetrieve(`subscriptions/${encodeURIComponent(subscriptionId)}`);
    } catch (error) {
      logError("billing.webhook_latest_subscription_fetch_failed", {
        eventId,
        error: error instanceof Error ? error.message : "unknown",
      });
      // Do not mark the event processed when the current Stripe object could
      // not be read. Stripe will retry, and the event remains recoverable.
      return NextResponse.json({ error: "Unable to verify current Stripe subscription state" }, { status: 502 });
    }
  }

  const snapshotMetadataTenantId = typeof (obj.metadata as Record<string, unknown> | undefined)?.tenant_id === "string"
    ? String((obj.metadata as Record<string, unknown>).tenant_id)
    : undefined;
  const stateMetadataTenantId = typeof (stateObj.metadata as Record<string, unknown> | undefined)?.tenant_id === "string"
    ? String((stateObj.metadata as Record<string, unknown>).tenant_id)
    : undefined;
  const clientReferenceTenantId = typeof obj.client_reference_id === "string" ? obj.client_reference_id : undefined;
  const candidateTenantId = stateMetadataTenantId ?? snapshotMetadataTenantId ?? clientReferenceTenantId;
  let checkoutSubscription: Record<string, unknown> | null = null;
  if (eventType === "checkout.session.completed") {
    const checkoutSubscriptionId = typeof obj.subscription === "string" ? obj.subscription : "";
    if (checkoutSubscriptionId) {
      try {
        checkoutSubscription = await stripeRetrieve(`subscriptions/${encodeURIComponent(checkoutSubscriptionId)}`);
      } catch (error) {
        logError("billing.webhook_checkout_subscription_fetch_failed", {
          eventId,
          error: error instanceof Error ? error.message : "unknown",
        });
        return NextResponse.json({ error: "Unable to verify checkout subscription state" }, { status: 502 });
      }
    }
  }

  const customerId =
    typeof stateObj.customer === "string"
      ? stateObj.customer
      : typeof obj.customer === "string"
        ? obj.customer
        : undefined;
  const objectSubscriptionId = subscriptionIdForEvent(eventType, stateObj);

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
            status?: "trialing" | "active" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "paused" | "cancelled";
            stripeLastEventCreatedAt?: Date | string | null;
          } | undefined;
          const differentSubscription = Boolean(current?.stripeSubscriptionId && current.stripeSubscriptionId !== subId);
          if (differentSubscription && current?.status !== "cancelled") {
            await tx.update(billingEvents)
              .set({ tenantId, processedAt: new Date() })
              .where(eq(billingEvents.eventId, eventId));
            await writeAuditEvent({
              tenantId,
              actorType: "platform",
              actorId: "stripe",
              action: "billing.identity_conflict",
              resourceType: "billing_event",
              resourceId: eventId,
            }, tx);
            return { kind: "ignored" as const };
          }
          const currentStripeCheckoutCustomer =
            typeof checkoutSubscription?.customer === "string" ? checkoutSubscription.customer : customerId;
          const currentStripeCheckoutStatus =
            typeof checkoutSubscription?.status === "string" ? checkoutSubscription.status : undefined;
          if (currentStripeCheckoutCustomer && customerId && currentStripeCheckoutCustomer !== customerId) {
            await tx.update(billingEvents)
              .set({ tenantId, processedAt: new Date() })
              .where(eq(billingEvents.eventId, eventId));
            await writeAuditEvent({
              tenantId,
              actorType: "platform",
              actorId: "stripe",
              action: "billing.checkout_customer_conflict",
              resourceType: "billing_event",
              resourceId: eventId,
            }, tx);
            return { kind: "ignored" as const };
          }
          if (differentSubscription && current?.status === "cancelled" && currentStripeCheckoutStatus === "canceled") {
            await tx.update(billingEvents)
              .set({ tenantId, processedAt: new Date() })
              .where(eq(billingEvents.eventId, eventId));
            await writeAuditEvent({
              tenantId,
              actorType: "platform",
              actorId: "stripe",
              action: "billing.stale_checkout_subscription",
              resourceType: "billing_event",
              resourceId: eventId,
            }, tx);
            return { kind: "ignored" as const };
          }
          if (current?.stripeCustomerId && customerId && current.stripeCustomerId !== customerId) {
            await tx.update(billingEvents)
              .set({ tenantId, processedAt: new Date() })
              .where(eq(billingEvents.eventId, eventId));
            await writeAuditEvent({
              tenantId,
              actorType: "platform",
              actorId: "stripe",
              action: "billing.checkout_customer_conflict",
              resourceType: "billing_event",
              resourceId: eventId,
            }, tx);
            return { kind: "ignored" as const };
          }
          const checkoutSessionId = typeof obj.id === "string" ? obj.id : undefined;
          await tx.update(tenantSubscriptions).set({
            stripeSubscriptionId: differentSubscription ? subId : (current?.stripeSubscriptionId ?? subId),
            stripeCustomerId: current?.stripeCustomerId ?? (customerId ?? null),
            checkoutStatus: "completed",
            checkoutSessionId: checkoutSessionId ?? null,
            updatedAt: new Date(),
          }).where(eq(tenantSubscriptions.tenantId, tenantId));
        }
      } else if (eventType.startsWith("customer.subscription.")) {
        const subId = typeof stateObj.id === "string" ? stateObj.id : "";
        const items = stateObj.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
        const priceId = items?.data?.[0]?.price?.id;
        const tenantRowResult = tenantId ? await tx.execute(sql`
          SELECT tenant_id AS "tenantId",
                 stripe_subscription_id AS "stripeSubscriptionId",
                 stripe_customer_id AS "stripeCustomerId",
                 status,
                 checkout_status AS "checkoutStatus",
                 checkout_plan_id AS "checkoutPlanId",
                 checkout_idempotency_key AS "checkoutIdempotencyKey",
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
          checkoutStatus?: "none" | "creating" | "open" | "completed";
          checkoutPlanId?: string | null;
          checkoutIdempotencyKey?: string | null;
          currentPeriodEnd?: Date | string | null;
          cancelAtPeriodEnd?: boolean;
          planId?: string;
          stripeLastEventCreatedAt?: Date | string | null;
        } | undefined;
        const plan = priceId ? await tx.query.plans.findFirst({ where: eq(plans.stripePriceId, priceId), columns: { id: true } }) : undefined;
        if (tenantRow && tenantId) {
          const differentSubscription = Boolean(
            tenantRow.stripeSubscriptionId && tenantRow.stripeSubscriptionId !== subId
          );
          // A subscription event for a different Stripe subscription must never
          // overwrite the tenant's currently bound identity. A replacement is
          // adopted only when the current local state is cancelled and the
          // incoming Stripe event is strictly newer than the stored lifecycle
          // timestamp; equal-second ties remain intentionally ambiguous.
          const sameOrUnboundSubscription =
            !tenantRow.stripeSubscriptionId || tenantRow.stripeSubscriptionId === subId;
          // stripeLastEventCreatedAt comes from raw execute(): naive UTC string,
          // not Date. Normalize via parseDbTimeMs so the newer-event gate works.
          const storedStripeEventCreatedAtMs = parseDbTimeMs(tenantRow.stripeLastEventCreatedAt);
          const newerReplacementSubscription =
            differentSubscription &&
            tenantRow.status === "cancelled" &&
            storedStripeEventCreatedAtMs !== null &&
            eventCreatedAt.getTime() > storedStripeEventCreatedAtMs;
          if (sameOrUnboundSubscription || newerReplacementSubscription) {
            const nextStatus = typeof stateObj.status === "string" ? statusOf(stateObj.status) : tenantRow.status;
            await tx.update(tenantSubscriptions).set({
              stripeCustomerId: typeof stateObj.customer === "string" ? stateObj.customer : tenantRow.stripeCustomerId,
              stripeSubscriptionId: subId || tenantRow.stripeSubscriptionId,
              status: nextStatus,
              currentPeriodEnd: typeof stateObj.current_period_end === "number" ? new Date(stateObj.current_period_end * 1000) : parseDbTime(tenantRow.currentPeriodEnd),
              cancelAtPeriodEnd: stateObj.cancel_at_period_end === true,
              planId: plan?.id ?? tenantRow.planId,
              ...(nextStatus === "cancelled" || nextStatus === "incomplete_expired"
                ? {
                    checkoutStatus: "none" as const,
                    checkoutPlanId: null,
                    checkoutIdempotencyKey: null,
                    checkoutSessionId: null,
                    checkoutSessionUrl: null,
                    checkoutSessionExpiresAt: null,
                  }
                : {}),
              stripeLastEventCreatedAt: sql`GREATEST(COALESCE(${tenantSubscriptions.stripeLastEventCreatedAt}, ${eventCreatedAt}), ${eventCreatedAt})`,
              updatedAt: new Date(),
            }).where(eq(tenantSubscriptions.tenantId, tenantId));
          }
        }
      } else if (eventType === "invoice.paid" || eventType === "invoice.payment_failed") {
        // Invoice events are payment facts, not authoritative subscription lifecycle
        // snapshots. Stripe's subscription lifecycle events own access state; in
        // particular, invoice.paid must not reactivate a subscription that Stripe
        // currently reports as canceled/unpaid, and invoice.payment_failed must not
        // manufacture a past_due state when the subscription object is still active,
        // incomplete, or otherwise in a different lifecycle state.
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