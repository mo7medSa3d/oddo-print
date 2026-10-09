import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { billingEvents, plans, tenantSubscriptions } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { parseDbTimeMs } from "../../../../lib/database-clock";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { stripeRetrieve, stripeSubscriptionPeriod, verifyStripeSignature } from "../../../../lib/stripe";
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

const INTERNAL_EVENT_KEY = "__yaseir";

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

export async function POST(req: Request) { return handleWebhook(req); }

async function handleWebhook(req: Request, snapshotRetry = 0): Promise<NextResponse> {
  if (hasBodyOverLimit(req, 2 * 1024 * 1024)) {
    return NextResponse.json({ error: "Webhook payload too large" }, { status: 413 });
  }
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  const secret = runtimeSecret("STRIPE_WEBHOOK_SECRET");
  // Deliberate 400 (not 401): Stripe's convention is non-2xx for failed
  // validation, and the integration contract pins 400 + this exact body
  // (billing-webhook.test.ts "missing/invalid Stripe signature"). A 401
  // buys nothing here — verification is HMAC, not a brute-forceable
  // credential — and would churn Stripe's delivery dashboard semantics.
  if (!secret || !verifyStripeSignature(raw, sig, secret)) return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });

  let event: StripeEvent;
  try { const parsed = JSON.parse(raw); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required"); event = parsed as StripeEvent; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!eventId || !eventType || !Number.isSafeInteger(event.created) || Number(event.created) < 0) {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  }

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
  if (typeof obj !== "object" || !obj || Array.isArray(obj)) return NextResponse.json({ error: "Invalid event object" }, { status: 400 });
  const eventCreatedAt = new Date(Number(event.created) * 1000);
  const eventCreatedUnix = Math.floor(eventCreatedAt.getTime() / 1000);

  // Subscription lifecycle events are authoritative for access state. For all
  // lifecycle events whose subscription still exists, retrieve the current
  // Stripe resource instead of trusting the event snapshot: Stripe timestamps
  // are second-resolution and webhook delivery order is not guaranteed.
  // A deleted subscription cannot be retrieved after termination, so its
  // signed event snapshot is the terminal source of truth and gets a special
  // same-second fence below.
  const currentSnapshotSubscriptionEvents = new Set([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.paused",
    "customer.subscription.resumed",
    "customer.subscription.pending_update_applied",
    "customer.subscription.pending_update_expired",
  ]);
  const subscriptionStateEvent =
    eventType === "customer.subscription.deleted" || currentSnapshotSubscriptionEvents.has(eventType);

  let stateObj: Record<string, unknown> = obj;
  let staleSnapshotEvent = false;
  let fetchedRevision: number | null = null;
  if (currentSnapshotSubscriptionEvents.has(eventType)) {
    const subscriptionId = typeof obj.id === "string" ? obj.id : "";
    if (!subscriptionId) return NextResponse.json({ error: "Subscription event missing subscription id" }, { status: 400 });
    const knownSubscription = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.stripeSubscriptionId, subscriptionId),
      columns: { stripeLastEventCreatedAt: true, stripeStateRevision: true },
    });
    fetchedRevision = knownSubscription?.stripeStateRevision ?? null;
    const knownEventMs = parseDbTimeMs(knownSubscription?.stripeLastEventCreatedAt);
    const skipStaleSnapshotFetch =
      knownEventMs !== null && eventCreatedAt.getTime() < knownEventMs;
    staleSnapshotEvent = skipStaleSnapshotFetch;

    if (!skipStaleSnapshotFetch) {
      try {
        stateObj = await stripeRetrieve(`subscriptions/${encodeURIComponent(subscriptionId)}`);
    } catch (error) {
      logError("billing.webhook_latest_subscription_fetch_failed", {
        eventId,
        error: error instanceof Error ? error.message : "unknown",
      });
        return NextResponse.json({ error: "Unable to verify current Stripe subscription state" }, { status: 502 });
      }
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
      const known = candidateTenantId ? await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, candidateTenantId), columns: { stripeStateRevision: true } }) : undefined;
      fetchedRevision = known?.stripeStateRevision ?? null;
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
      // Identify first without row locks, then lock tenants before subscriptions.
      // Checkout/onboarding use the same order; audit FK writes must not invert it.
      const identities = await tx.execute(sql`SELECT tenant_id AS "tenantId" FROM tenant_subscriptions WHERE (${objectSubscriptionId ? sql`stripe_subscription_id = ${objectSubscriptionId}` : sql`FALSE`}) OR (${customerId ? sql`stripe_customer_id = ${customerId}` : sql`FALSE`})`);
      const lockTenantIds = [...new Set([
        ...(identities.rows as Array<{ tenantId: string }>).map(row => row.tenantId),
        ...(candidateTenantId ? [candidateTenantId] : []),
      ])].sort();
      if (lockTenantIds.length) await tx.execute(sql`SELECT id FROM tenants WHERE id IN (${sql.join(lockTenantIds.map(id => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
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
          .set({ tenantId: boundTenantId ?? null, processedAt: sql`clock_timestamp()` })
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
                   stripe_state_revision AS "stripeStateRevision",
                 stripe_last_event_created_at AS "stripeLastEventCreatedAt"
            FROM tenant_subscriptions
            WHERE tenant_id = ${tenantId}
            FOR UPDATE
          `);
          const current = currentResult.rows[0] as {
            stripeStateRevision?: number | string;
            stripeSubscriptionId?: string | null;
            stripeCustomerId?: string | null;
            status?: "trialing" | "active" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "paused" | "cancelled";
            stripeLastEventCreatedAt?: Date | string | null;
          } | undefined;
          if (checkoutSubscription && Number(current?.stripeStateRevision ?? 0) !== (fetchedRevision ?? 0)) throw new Error("BILLING_SNAPSHOT_CHANGED");
          const differentSubscription = Boolean(current?.stripeSubscriptionId && current.stripeSubscriptionId !== subId);
          if (differentSubscription && current?.status !== "cancelled") {
            await tx.update(billingEvents)
              .set({ tenantId, processedAt: sql`clock_timestamp()` })
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
              .set({ tenantId, processedAt: sql`clock_timestamp()` })
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
              .set({ tenantId, processedAt: sql`clock_timestamp()` })
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
              .set({ tenantId, processedAt: sql`clock_timestamp()` })
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
          const checkoutPeriod = stripeSubscriptionPeriod(checkoutSubscription);
          await tx.update(tenantSubscriptions).set({
            stripeSubscriptionId: differentSubscription ? subId : (current?.stripeSubscriptionId ?? subId),
            stripeCustomerId: current?.stripeCustomerId ?? (customerId ?? null),
            checkoutStatus: "completed",
            stripeStateRevision: sql`${tenantSubscriptions.stripeStateRevision} + 1`,
            checkoutSessionId: checkoutSessionId ?? null,
            // Lifecycle events own current periods once their fence exists.
            // Checkout completion may arrive after a newer renewal snapshot.
            currentPeriodStart: differentSubscription || !current?.stripeLastEventCreatedAt ? checkoutPeriod.start ?? undefined : undefined,
            currentPeriodEnd: differentSubscription || !current?.stripeLastEventCreatedAt ? checkoutPeriod.end ?? undefined : undefined,
            ...(differentSubscription ? { stripeLastEventCreatedAt: null } : {}),
            updatedAt: sql`clock_timestamp()`,
          }).where(eq(tenantSubscriptions.tenantId, tenantId));
        }
      } else if (subscriptionStateEvent) {
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
                 current_period_start AS "currentPeriodStart",
                 current_period_end AS "currentPeriodEnd",
                 cancel_at_period_end AS "cancelAtPeriodEnd",
                 plan_id AS "planId",
                 entitlement_blocked AS "entitlementBlocked",
                 entitlement_blocked_reason AS "entitlementBlockedReason",
                 stripe_state_revision AS "stripeStateRevision",
                 stripe_last_event_created_at AS "stripeLastEventCreatedAt"
          FROM tenant_subscriptions
          WHERE tenant_id = ${tenantId}
          FOR UPDATE
        `) : null;
        const tenantRow = tenantRowResult?.rows[0] as {
          tenantId?: string;
          stripeStateRevision?: number | string;
          stripeSubscriptionId?: string | null;
          stripeCustomerId?: string | null;
          status?: "trialing" | "active" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "paused" | "cancelled";
          checkoutStatus?: "none" | "creating" | "open" | "completed";
          checkoutPlanId?: string | null;
          checkoutIdempotencyKey?: string | null;
          currentPeriodStart?: Date | string | null;
          currentPeriodEnd?: Date | string | null;
          cancelAtPeriodEnd?: boolean;
          planId?: string;
          entitlementBlocked?: boolean;
          entitlementBlockedReason?: string | null;
          stripeLastEventCreatedAt?: Date | string | null;
        } | undefined;
        const mappings = priceId ? await tx.query.plans.findMany({ where: sql`${plans.stripePriceId} = ${priceId} OR ${priceId} = ANY(${plans.stripePriceHistory})`, columns: { id: true }, limit: 2 }) : [];
        const plan = mappings.length === 1 ? mappings[0] : undefined;
        const priceMappingAuthoritative = eventType === "customer.subscription.created" || eventType === "customer.subscription.updated";
        const entitlementBlocked = priceMappingAuthoritative ? !plan : tenantRow?.entitlementBlocked === true;
        if (tenantRow && tenantId) {
          if (currentSnapshotSubscriptionEvents.has(eventType) && !staleSnapshotEvent && Number(tenantRow.stripeStateRevision ?? 0) !== (fetchedRevision ?? 0)) throw new Error("BILLING_SNAPSHOT_CHANGED");
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
          const isNewerThanStoredEvent =
            storedStripeEventCreatedAtMs === null || eventCreatedAt.getTime() > storedStripeEventCreatedAtMs;
          const newerReplacementSubscription =
            differentSubscription &&
            tenantRow.status === "cancelled" &&
            isNewerThanStoredEvent;
          // A live Stripe resource is authoritative even when the triggering
          // event shares a second with another event or arrived much later.
          // Re-evaluating the resource makes paused/resumed and other lifecycle
          // events converge on Stripe's current state. Deleted is the exception:
          // Stripe's terminated resource is no longer retrievable, so the signed
          // deletion event is a terminal fence and can advance on an equal timestamp.
          // The Stripe retrieve() happened before this transaction acquired the
          // tenant row lock. Another webhook may have fetched a newer remote
          // snapshot and committed it while this request was waiting. Never let
          // that older fetched snapshot overwrite the newer persisted event fence.
          // Ties (>=, not >) converge on the live snapshot: same-second
          // paused/resumed pairs are otherwise order-of-arrival coin flips.
          // Strictly older events still never overwrite (see the < gate on
          // the snapshot fetch above and isNewerThanStoredEvent below).
          //
          // A locally cancelled row bound by a COMPLETED checkout is not an
          // authoritative terminal cancellation. Stripe does not guarantee
          // delivery order, so checkout.session.completed may bind the
          // subscription ID before subscription.created/updated arrives;
          // blocking that first lifecycle event strands a paying workspace.
          // Likewise a fresh completed checkout that rebinds a previously
          // cancelled subscription must let the new subscription's strictly
          // newer lifecycle events adopt. Genuine cancellations always stamp
          // stripeLastEventCreatedAt and clear checkout state to "none", so
          // they never match: stale/duplicate events stay fenced by the
          // newer-event gate, and equal-second ties stay intentionally
          // ambiguous.
          const terminalDelete =
            eventType === "customer.subscription.deleted";
          const adoptableCheckoutBinding =
            tenantRow.status === "cancelled" &&
            tenantRow.stripeSubscriptionId === subId &&
            tenantRow.checkoutStatus === "completed" &&
            !terminalDelete &&
            (tenantRow.stripeLastEventCreatedAt == null || isNewerThanStoredEvent);
          const currentSnapshotAuthoritative =
            currentSnapshotSubscriptionEvents.has(eventType) &&
            !staleSnapshotEvent &&
            (storedStripeEventCreatedAtMs === null || eventCreatedAt.getTime() >= storedStripeEventCreatedAtMs);
          const sameSubscriptionCanUpdate =
            sameOrUnboundSubscription &&
            (currentSnapshotAuthoritative || terminalDelete || isNewerThanStoredEvent)
            && !(tenantRow.status === "cancelled" && tenantRow.stripeSubscriptionId === subId && !terminalDelete && !adoptableCheckoutBinding);
          if (sameSubscriptionCanUpdate || newerReplacementSubscription) {
            const nextStatus = typeof stateObj.status === "string" ? statusOf(stateObj.status) : tenantRow.status;
            const subscriptionPeriod = stripeSubscriptionPeriod(stateObj);
            const currentPeriodStart = subscriptionPeriod.start ?? parseDbTime(tenantRow.currentPeriodStart);
            if (!currentPeriodStart) throw new Error("subscription current_period_start is missing or invalid");
            await tx.update(tenantSubscriptions).set({
              stripeCustomerId: typeof stateObj.customer === "string" ? stateObj.customer : tenantRow.stripeCustomerId,
              stripeSubscriptionId: subId || tenantRow.stripeSubscriptionId,
              status: nextStatus,
              stripeStateRevision: sql`${tenantSubscriptions.stripeStateRevision} + 1`,
              currentPeriodStart,
              currentPeriodEnd: subscriptionPeriod.end ?? parseDbTime(tenantRow.currentPeriodEnd),
              cancelAtPeriodEnd: stateObj.cancel_at_period_end === true,
              planId: plan?.id ?? tenantRow.planId,
              entitlementBlocked,
              entitlementBlockedReason: priceMappingAuthoritative && entitlementBlocked
                ? `stripe_price_unmapped:${priceId || "missing"}`
                : (priceMappingAuthoritative ? null : tenantRow.entitlementBlockedReason),
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
              updatedAt: sql`clock_timestamp()`,
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
        .set({ tenantId: tenantId ?? null, processedAt: sql`clock_timestamp()` })
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
    if (error instanceof Error && error.message === "BILLING_SNAPSHOT_CHANGED") {
      if (snapshotRetry < 2) return handleWebhook(new Request(req.url, { method: "POST", headers: req.headers, body: raw }), snapshotRetry + 1);
      return NextResponse.json({ error: "Subscription changed while verifying Stripe state; retry safely" }, { status: 503, headers: { "Retry-After": "1" } });
    }
    logError("billing.webhook_failed", { eventId, error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}