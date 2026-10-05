import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { plans, tenantSubscriptions, tenants } from "../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { isDefinitiveStripeMutationError, stripeList, stripeRequest, stripeRetrieve, stripeSubscriptionPeriod } from "../../../../lib/stripe";
import { gatewayNowMs, refreshClockSkew, parseDbTimeMs } from "../../../../lib/database-clock";
import { hasBodyOverLimit } from "../../../../lib/request-limits";

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["trialing", "active", "past_due"]);
const CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES = new Set(["paused", "unpaid", "incomplete"]);
const CHECKOUT_IDEMPOTENCY_REPLAY_MAX_AGE_MS = 23 * 60 * 60 * 1000;
const CHECKOUT_SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CHECKOUT_STALE_RECONCILE_AGE_MS = 25 * 60 * 60 * 1000;
const STRIPE_NONTERMINAL_SUBSCRIPTION_STATUSES = new Set(["trialing", "active", "past_due", "incomplete", "unpaid", "paused"]);

/**
 * A persisted Checkout Session is expired when Stripe's `expires_at` has
 * passed. Both sides of the comparison live outside Node's clock (Stripe wrote
 * the timestamp), so the calibrated Gateway clock is used: with a host clock
 * running ahead, a still-open session would be treated as expired and the user
 * would be handed a dead redirect URL — or, worse, a second Stripe Checkout
 * Session would be opened while the first is still payable.
 */
function checkoutIntentExpired(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) return false;
  const nowMs = gatewayNowMs();
  if (expiresAt instanceof Date) return expiresAt.getTime() <= nowMs;
  // Raw-string fallback: naive PG timestamps parse as UTC, not host-local.
  let iso = expiresAt.replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) {
    iso += /[+-]\d{2}$/.test(iso) ? ":00" : "Z";
  }
  const value = Date.parse(iso);
  return Number.isFinite(value) && value <= nowMs;
}

function replayableCheckoutSnapshot(snapshot: Record<string, string> | null, createdAt: Date | string | null): Record<string, string> | null {
  const createdMs = parseDbTimeMs(createdAt);
  const ageMs = createdMs === null ? Number.POSITIVE_INFINITY : gatewayNowMs() - createdMs;
  if (ageMs < 0 || ageMs >= CHECKOUT_IDEMPOTENCY_REPLAY_MAX_AGE_MS) return null;
  if (!snapshot || !Object.keys(snapshot).length || Object.values(snapshot).some(value => typeof value !== "string")) return null;
  return snapshot;
}

function creatingCheckoutCanBeAbandoned(
  intentCreatedAt: Date | string | null | undefined,
  lastAttemptAt: Date | string | null | undefined,
): boolean {
  const lastAttemptMs = parseDbTimeMs(lastAttemptAt);
  const intentCreatedMs = parseDbTimeMs(intentCreatedAt) ?? lastAttemptMs;
  if (intentCreatedMs === null || lastAttemptMs === null) return false;
  const nowMs = gatewayNowMs();
  const intentAgeMs = nowMs - intentCreatedMs;
  const lastAttemptAgeMs = nowMs - lastAttemptMs;
  // Stripe may prune idempotency keys after 24h and Checkout Sessions can live
  // for up to 24h. Wait an extra hour beyond BOTH the original intent and the
  // most recent external attempt before read-side reconciliation is allowed.
  // The reconciliation step below still proves that no non-terminal Stripe
  // subscription exists before it rotates the key.
  return intentAgeMs >= CHECKOUT_STALE_RECONCILE_AGE_MS
    && lastAttemptAgeMs >= CHECKOUT_STALE_RECONCILE_AGE_MS;
}

function creatingCheckoutRetryAfterSeconds(lastAttemptAt: Date | string | null | undefined): number {
  const lastAttemptMs = parseDbTimeMs(lastAttemptAt);
  if (lastAttemptMs === null) return Math.ceil(CHECKOUT_STALE_RECONCILE_AGE_MS / 1000);
  const remainingMs = CHECKOUT_STALE_RECONCILE_AGE_MS - (gatewayNowMs() - lastAttemptMs);
  return Math.max(1, Math.ceil(remainingMs / 1000));
}


function localSubscriptionStatus(status: unknown): "trialing" | "active" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "paused" | "cancelled" | null {
  if (status === "trialing" || status === "active" || status === "past_due" || status === "incomplete" || status === "incomplete_expired" || status === "unpaid" || status === "paused") return status;
  if (status === "canceled" || status === "cancelled") return "cancelled";
  return null;
}

function stripeSubscriptionPriceId(subscription: Record<string, unknown>): string | null {
  const items = subscription.items && typeof subscription.items === "object" && !Array.isArray(subscription.items)
    ? subscription.items as { data?: unknown[] }
    : null;
  const first = Array.isArray(items?.data) ? items.data[0] : null;
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const price = (first as Record<string, unknown>).price;
  if (!price || typeof price !== "object" || Array.isArray(price)) return null;
  return typeof (price as Record<string, unknown>).id === "string" ? String((price as Record<string, unknown>).id) : null;
}

function stripeSubscriptionMetadata(subscription: Record<string, unknown>): Record<string, unknown> {
  return subscription.metadata && typeof subscription.metadata === "object" && !Array.isArray(subscription.metadata)
    ? subscription.metadata as Record<string, unknown>
    : {};
}

async function planForStripeSubscription(subscription: Record<string, unknown>) {
  const metadata = stripeSubscriptionMetadata(subscription);
  const metadataPlanId = typeof metadata.plan_id === "string" ? metadata.plan_id : null;
  const priceId = stripeSubscriptionPriceId(subscription);

  if (metadataPlanId) {
    const mapped = await db.query.plans.findFirst({ where: eq(plans.id, metadataPlanId) });
    if (mapped) {
      const knownPrices = new Set([mapped.stripePriceId, ...(mapped.stripePriceHistory ?? [])].filter(Boolean));
      if (!priceId || knownPrices.has(priceId)) return mapped;
    }
  }

  if (!priceId) return null;
  const matches = await db.query.plans.findMany({
    where: sql`${plans.stripePriceId} = ${priceId} OR ${priceId} = ANY(${plans.stripePriceHistory})`,
    limit: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  const claims = await validateWorkspaceManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "billing.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Subscription-period decisions below compare Stripe/DB timestamps with the
  // calibrated Gateway clock (cached for 30s; never a per-request round trip).
  await refreshClockSkew();

  let body: { planId?: unknown } = {};
  try {
    const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  if (!plan) {
    return NextResponse.json({ error: "Plan is not billable" }, { status: 400 });
  }

  const buildCheckoutRequestParams = (): Record<string, string> => {
    if (!plan.isActive || !plan.isPublic || !plan.stripePriceId) throw new Error("PLAN_NOT_BILLABLE");
    const base = (runtimeSecret("APP_BASE_URL") ?? new URL(req.url).origin).replace(/\/$/, "");
    return {
      mode: "subscription",
      client_reference_id: claims.tenantId,
      success_url: `${base}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/billing?checkout=cancelled`,
      "line_items[0][price]": plan.stripePriceId,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][tenant_id]": claims.tenantId,
      "subscription_data[metadata][plan_id]": plan.id,
    };
  };

  type CheckoutState =
    | { kind: "already_subscribed" }
    | { kind: "subscription_needs_attention"; status: string }
    // An open, unexpired session for the SAME plan: replaying it and finding
    // one mid-flight are the same outcome, so one kind carries both.
    | { kind: "in_progress"; url?: string }
    | { kind: "plan_conflict"; openPlanId: string }
    | { kind: "recovery_wait"; retryAfterSeconds: number }
    | { kind: "recovery_blocked"; reason: string }
    | { kind: "reconcile_stale"; priorPlanId: string | null; priorIdempotencyKey: string | null; customerId: string | null; intentCreatedAt: Date | string | null; lastAttemptAt: Date | string | null }
    | { kind: "proceed"; intentId: string; idempotencyKey: string; customerId: string | null; requestParams: Record<string, string> };

  let state: CheckoutState;
  try {
    state = await db.transaction(async (tx) => {
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

      if (sub?.stripeSubscriptionId && ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)) {
        return { kind: "already_subscribed" as const };
      }
      if (sub?.billingOperationId) {
        return { kind: "in_progress" as const };
      }

      const samePlan = sub?.checkoutPlanId === plan.id;
      const openUnexpired =
        sub?.checkoutStatus === "open" &&
        samePlan &&
        !!sub.checkoutSessionUrl &&
        !checkoutIntentExpired(sub.checkoutSessionExpiresAt);

      if (sub && openUnexpired) {
        return { kind: "in_progress" as const, url: sub.checkoutSessionUrl! };
      }

      const abandonableCreatingIntent =
        sub?.checkoutStatus === "creating" &&
        creatingCheckoutCanBeAbandoned(sub.checkoutIntentCreatedAt, sub.updatedAt);

      if (sub?.checkoutStatus === "creating" && abandonableCreatingIntent) {
        // Never rotate an aged idempotency key directly. A Checkout Session may
        // have completed while its response/webhook was lost, producing a real
        // Stripe subscription. Reconcile Stripe read-side state outside this DB
        // transaction first; only a proven no-subscription outcome may mint a
        // fresh intent.
        return {
          kind: "reconcile_stale" as const,
          priorPlanId: sub.checkoutPlanId ?? null,
          priorIdempotencyKey: sub.checkoutIdempotencyKey ?? null,
          customerId: sub.stripeCustomerId ?? null,
          intentCreatedAt: sub.checkoutIntentCreatedAt ?? null,
          lastAttemptAt: sub.updatedAt ?? null,
        };
      }

      if (
        sub?.checkoutStatus === "creating" &&
        sub.checkoutPlanId &&
        sub.checkoutPlanId !== plan.id
      ) {
        // The pending intent may already exist as a live Checkout Session at
        // Stripe. Keep the cross-plan fence until a full maximum Checkout
        // Session lifetime has elapsed since the LAST external attempt; after
        // that point any ambiguously-created Session is necessarily expired.
        return { kind: "plan_conflict" as const, openPlanId: sub.checkoutPlanId };
      }

      if (
        sub?.checkoutStatus === "open" &&
        !checkoutIntentExpired(sub.checkoutSessionExpiresAt)
      ) {
        if (sub.checkoutPlanId && sub.checkoutPlanId !== plan.id) {
          // Never hand back another plan's checkout URL: the client redirects
          // to `url` directly, so a mismatched URL would silently send the
          // user to pay for a plan they did not choose. The fence stands —
          // only the response becomes an explicit, named conflict.
          return { kind: "plan_conflict" as const, openPlanId: sub.checkoutPlanId };
        }
        return {
          kind: "in_progress" as const,
          ...(sub.checkoutSessionUrl ? { url: sub.checkoutSessionUrl } : {}),
        };
      }

      if (sub?.checkoutStatus === "completed") {
        return { kind: "in_progress" as const };
      }

      // While Stripe still guarantees the idempotency key, replay the exact
      // persisted request snapshot. Once that replay window has elapsed we do
      // NOT reuse the old key: Stripe may prune keys after 24h, so doing so
      // could create another payable Session. Instead wait until a full maximum
      // Checkout Session lifetime has elapsed since the last external attempt;
      // then the old intent is safe to abandon and a fresh key may be minted.
      if (
        sub?.checkoutStatus === "creating" &&
        sub.checkoutPlanId === plan.id &&
        sub.checkoutIdempotencyKey &&
        !abandonableCreatingIntent
      ) {
        const replaySnapshot = replayableCheckoutSnapshot(sub.checkoutRequestParams, sub.checkoutIntentCreatedAt);
        if (!replaySnapshot) {
          return {
            kind: "recovery_wait" as const,
            retryAfterSeconds: creatingCheckoutRetryAfterSeconds(sub.updatedAt),
          };
        }
        return {
          kind: "proceed" as const,
          intentId: sub.checkoutIdempotencyKey.replace(/^checkout-intent-/, ""),
          idempotencyKey: sub.checkoutIdempotencyKey,
          customerId: sub.stripeCustomerId ?? null,
          requestParams: replaySnapshot,
        };
      }

      // Never create a second subscription while Stripe already owns an
      // unresolved non-terminal subscription. Incomplete, unpaid, and paused
      // states must be recovered through the existing Stripe subscription.
      if (sub?.stripeSubscriptionId && CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES.has(sub.status)) {
        return { kind: "subscription_needs_attention" as const, status: sub.status };
      }

      const requestParams = buildCheckoutRequestParams();
      const intentId = `chk_${randomUUID()}`;
      const idempotencyKey = `checkout-intent-${intentId}`;

      if (!sub) {
        await tx.insert(tenantSubscriptions).values({
          tenantId: claims.tenantId,
          planId: plan.id,
          status: "cancelled",
          // Stamped by PostgreSQL: this value keys print_usage_periods and is
          // validated against Stripe's current_period_end (period_end must be
          // later), so a host clock ahead of the database would make a paying
          // tenant's period look invalid and block every print with 403.
          currentPeriodStart: sql`now()`,
          updatedAt: sql`now()`,
          checkoutStatus: "creating",
          checkoutPlanId: plan.id,
          checkoutIdempotencyKey: idempotencyKey,
          checkoutRequestParams: requestParams,
          checkoutIntentCreatedAt: sql`clock_timestamp()`,
        });
        sub = await tx.query.tenantSubscriptions.findFirst({
          where: eq(tenantSubscriptions.tenantId, claims.tenantId),
        });
      } else {
        const expiredCheckout =
          sub.checkoutStatus === "open" &&
          checkoutIntentExpired(sub.checkoutSessionExpiresAt);
        if (
          sub.checkoutStatus !== "creating" ||
          !sub.checkoutIdempotencyKey ||
          expiredCheckout ||
          sub.checkoutPlanId !== plan.id
        ) {
          await tx.update(tenantSubscriptions)
            .set({
              checkoutStatus: "creating",
              checkoutPlanId: plan.id,
              checkoutIdempotencyKey: idempotencyKey,
              checkoutRequestParams: requestParams,
              checkoutIntentCreatedAt: sql`clock_timestamp()`,
              checkoutSessionId: null,
              checkoutSessionUrl: null,
              checkoutSessionExpiresAt: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(tenantSubscriptions.tenantId, claims.tenantId));
        } else {
          const replaySnapshot = replayableCheckoutSnapshot(sub.checkoutRequestParams, sub.checkoutIntentCreatedAt);
          if (!replaySnapshot) {
            return {
              kind: "recovery_wait" as const,
              retryAfterSeconds: creatingCheckoutRetryAfterSeconds(sub.updatedAt),
            };
          }
          return {
            kind: "proceed" as const,
            intentId: sub.checkoutIdempotencyKey.replace(/^checkout-intent-/, ""),
            idempotencyKey: sub.checkoutIdempotencyKey,
            customerId: sub.stripeCustomerId ?? null,
            requestParams: replaySnapshot,
          };
        }
      }

      return {
        kind: "proceed" as const,
        intentId,
        idempotencyKey,
        customerId: sub?.stripeCustomerId ?? null,
        requestParams,
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "PLAN_NOT_BILLABLE") return NextResponse.json({ error: "Plan is not billable", code: "PLAN_NOT_BILLABLE" }, { status: 400 });
    if (error instanceof Error && error.message === "TENANT_NOT_FOUND") {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }
    if (error instanceof Error && error.message === "TENANT_NOT_ACTIVE") {
      return NextResponse.json({ error: "Tenant is not active" }, { status: 409 });
    }
    throw error;
  }


  if (state.kind === "reconcile_stale") {
    const stale = state;
    let recoveredSubscription: Record<string, unknown> | null = null;

    if (stale.customerId) {
      try {
        const page = await stripeList("subscriptions", new URLSearchParams({
          customer: stale.customerId,
          status: "all",
          limit: "100",
        }));
        if (page.hasMore) {
          state = {
            kind: "recovery_blocked",
            reason: "Stripe returned more subscriptions than can be reconciled safely in one bounded request.",
          };
        } else {
          const nonterminal = page.data.filter((subscription) => {
            const customerId = typeof subscription.customer === "string" ? subscription.customer : null;
            const status = localSubscriptionStatus(subscription.status);
            return customerId === stale.customerId && !!status && STRIPE_NONTERMINAL_SUBSCRIPTION_STATUSES.has(status);
          });

          if (nonterminal.length > 1) {
            state = {
              kind: "recovery_blocked",
              reason: "Stripe reports multiple non-terminal subscriptions for this workspace customer.",
            };
          } else if (nonterminal.length === 1) {
            const subscriptionId = String(nonterminal[0].id);
            const current = await stripeRetrieve(`subscriptions/${encodeURIComponent(subscriptionId)}`);
            const currentStatus = localSubscriptionStatus(current.status);
            const currentCustomerId = typeof current.customer === "string" ? current.customer : null;
            const metadata = stripeSubscriptionMetadata(current);
            const metadataTenantId = typeof metadata.tenant_id === "string" ? metadata.tenant_id : null;

            if (currentCustomerId !== stale.customerId || (metadataTenantId && metadataTenantId !== claims.tenantId)) {
              state = {
                kind: "recovery_blocked",
                reason: "Stripe subscription identity does not match this workspace.",
              };
            } else if (currentStatus && STRIPE_NONTERMINAL_SUBSCRIPTION_STATUSES.has(currentStatus)) {
              recoveredSubscription = current;
            }
          }
        }
      } catch (error) {
        console.error("billing checkout reconciliation failed", error instanceof Error ? error.message : "unknown");
        state = {
          kind: "recovery_blocked",
          reason: "Stripe subscription state could not be verified right now.",
        };
      }
    }

    if (state.kind === "reconcile_stale" && recoveredSubscription) {
      const recoveredStatus = localSubscriptionStatus(recoveredSubscription.status);
      const recoveredPlan = await planForStripeSubscription(recoveredSubscription);
      const recoveredSubscriptionId = typeof recoveredSubscription.id === "string" ? recoveredSubscription.id : null;
      const recoveredCustomerId = typeof recoveredSubscription.customer === "string" ? recoveredSubscription.customer : null;
      const recoveredPeriod = stripeSubscriptionPeriod(recoveredSubscription);

      if (
        !recoveredStatus ||
        !STRIPE_NONTERMINAL_SUBSCRIPTION_STATUSES.has(recoveredStatus) ||
        !recoveredPlan ||
        !recoveredSubscriptionId ||
        recoveredCustomerId !== stale.customerId ||
        !recoveredPeriod.start
      ) {
        state = {
          kind: "recovery_blocked",
          reason: "Stripe subscription state could not be mapped safely to the local billing record.",
        };
      } else {
        const recoveredPeriodStart = recoveredPeriod.start;
        state = await db.transaction(async (tx): Promise<CheckoutState> => {
          await tx.execute(sql`
            SELECT id FROM tenants
            WHERE id = ${claims.tenantId}
            FOR UPDATE
          `);
          const current = await tx.query.tenantSubscriptions.findFirst({
            where: eq(tenantSubscriptions.tenantId, claims.tenantId),
          });
          if (!current) return { kind: "recovery_blocked", reason: "Local subscription state disappeared during reconciliation." };
          if (current.stripeSubscriptionId && current.stripeSubscriptionId !== recoveredSubscriptionId && current.status !== "cancelled") {
            return { kind: "recovery_blocked", reason: "A different Stripe subscription is already bound to this workspace." };
          }

          await tx.update(tenantSubscriptions).set({
            planId: recoveredPlan.id,
            stripeCustomerId: recoveredCustomerId,
            stripeSubscriptionId: recoveredSubscriptionId,
            status: recoveredStatus,
            currentPeriodStart: recoveredPeriodStart,
            currentPeriodEnd: recoveredPeriod.end ?? sql`NULL`,
            cancelAtPeriodEnd: recoveredSubscription.cancel_at_period_end === true,
            checkoutStatus: "completed",
            checkoutPlanId: recoveredPlan.id,
            checkoutIdempotencyKey: null,
            checkoutRequestParams: null,
            checkoutIntentCreatedAt: null,
            checkoutSessionId: null,
            checkoutSessionUrl: null,
            checkoutSessionExpiresAt: null,
            entitlementBlocked: false,
            entitlementBlockedReason: null,
            stripeStateRevision: sql`${tenantSubscriptions.stripeStateRevision} + 1`,
            updatedAt: sql`clock_timestamp()`,
          }).where(eq(tenantSubscriptions.tenantId, claims.tenantId));

          return ACTIVE_SUBSCRIPTION_STATUSES.has(recoveredStatus)
            ? { kind: "already_subscribed" }
            : { kind: "subscription_needs_attention", status: recoveredStatus };
        });
      }
    }

    if (state.kind === "reconcile_stale" && !recoveredSubscription) {
      // No Customer ID means this implementation could not have submitted a
      // Checkout Session: the customer response is persisted before the Session
      // POST. With a Customer ID, the read-side Stripe query above proved that
      // no non-terminal subscription currently exists. Recheck all local fences
      // under the tenant lock before rotating the stale key.
      state = await db.transaction(async (tx): Promise<CheckoutState> => {
        await tx.execute(sql`
          SELECT id, lifecycle
          FROM tenants
          WHERE id = ${claims.tenantId}
          FOR UPDATE
        `);
        const current = await tx.query.tenantSubscriptions.findFirst({
          where: eq(tenantSubscriptions.tenantId, claims.tenantId),
        });
        if (!current) return { kind: "recovery_blocked", reason: "Local subscription state disappeared during reconciliation." };
        if (current.stripeSubscriptionId && ACTIVE_SUBSCRIPTION_STATUSES.has(current.status)) {
          return { kind: "already_subscribed" };
        }
        if (current.stripeSubscriptionId && CHECKOUT_BLOCKING_SUBSCRIPTION_STATUSES.has(current.status)) {
          return { kind: "subscription_needs_attention", status: current.status };
        }
        if (current.billingOperationId) return { kind: "in_progress" };
        if (current.checkoutStatus !== "creating" || current.checkoutIdempotencyKey !== stale.priorIdempotencyKey) {
          if (current.checkoutStatus === "open" && current.checkoutSessionUrl && !checkoutIntentExpired(current.checkoutSessionExpiresAt)) {
            return current.checkoutPlanId && current.checkoutPlanId !== plan.id
              ? { kind: "plan_conflict", openPlanId: current.checkoutPlanId }
              : { kind: "in_progress", url: current.checkoutSessionUrl };
          }
          return { kind: "in_progress" };
        }
        if (stale.customerId === null && current.stripeCustomerId !== null) {
          return { kind: "recovery_wait", retryAfterSeconds: 1 };
        }
        if (!creatingCheckoutCanBeAbandoned(current.checkoutIntentCreatedAt, current.updatedAt)) {
          return { kind: "recovery_wait", retryAfterSeconds: creatingCheckoutRetryAfterSeconds(current.updatedAt) };
        }

        const requestParams = buildCheckoutRequestParams();
        const intentId = `chk_${randomUUID()}`;
        const idempotencyKey = `checkout-intent-${intentId}`;
        await tx.update(tenantSubscriptions).set({
          checkoutStatus: "creating",
          checkoutPlanId: plan.id,
          checkoutIdempotencyKey: idempotencyKey,
          checkoutRequestParams: requestParams,
          checkoutIntentCreatedAt: sql`clock_timestamp()`,
          checkoutSessionId: null,
          checkoutSessionUrl: null,
          checkoutSessionExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        }).where(eq(tenantSubscriptions.tenantId, claims.tenantId));

        return {
          kind: "proceed",
          intentId,
          idempotencyKey,
          customerId: current.stripeCustomerId ?? null,
          requestParams,
        };
      });
    }
  }

  if (state.kind === "already_subscribed") {
    return NextResponse.json(
      { error: "This workspace already has a Stripe subscription. Use the Customer Portal to change plans." },
      { status: 409 },
    );
  }
  if (state.kind === "subscription_needs_attention") {
    const message =
      state.status === "paused"
        ? "The Stripe subscription is paused. Add a payment method and resume the existing subscription before choosing a different plan."
        : state.status === "unpaid"
          ? "The Stripe subscription is unpaid. Resolve the outstanding payment in the Customer Portal before starting another subscription."
          : "The Stripe subscription is still incomplete. Complete the existing checkout or resolve the payment state before starting another subscription.";
    return NextResponse.json(
      { error: message, code: "SUBSCRIPTION_NEEDS_ATTENTION", status: state.status },
      { status: 409 },
    );
  }
  if (state.kind === "in_progress") {
    if (state.url) {
      return NextResponse.json({ ok: true, url: state.url, existing: true });
    }
    return NextResponse.json(
      { error: "A checkout operation is already in progress for this workspace." },
      { status: 409 },
    );
  }
  if (state.kind === "recovery_wait") {
    return NextResponse.json(
      {
        error: "The previous checkout result is still uncertain. Retry after the safety window so an ambiguously-created Stripe Checkout Session cannot be duplicated.",
        code: "CHECKOUT_RECONCILIATION_PENDING",
        retryAfterSeconds: state.retryAfterSeconds,
      },
      {
        status: 409,
        headers: { "Retry-After": String(state.retryAfterSeconds), "Cache-Control": "no-store" },
      },
    );
  }
  if (state.kind === "plan_conflict") {
    // Name the plan that owns the open session so the operator understands
    // which checkout must finish (or expire) before a different plan works.
    const openPlan = await db.query.plans.findFirst({
      where: eq(plans.id, state.openPlanId),
      columns: { name: true },
    });
    const openPlanName = openPlan?.name ?? "another plan";
    return NextResponse.json(
      {
        error: `You already have an open checkout for ${openPlanName}. Complete it or let it expire before choosing a different plan.`,
        code: "CHECKOUT_PLAN_CONFLICT",
        openPlanId: state.openPlanId,
      },
      { status: 409 },
    );
  }
  if (state.kind === "recovery_blocked") {
    return NextResponse.json(
      {
        error: state.reason,
        code: "CHECKOUT_RECONCILIATION_BLOCKED",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (state.kind !== "proceed") {
    return NextResponse.json(
      {
        error: "Checkout state could not be advanced safely. Retry with the current workspace state.",
        code: "CHECKOUT_STATE_CHANGED",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  let customerId = state.customerId;
  try {
    if (!customerId) {
      const customerParams = new URLSearchParams({
        description: `Yaseir Cloud Printing tenant ${claims.tenantId}`,
        "metadata[tenant_id]": claims.tenantId,
      });
      const customer = await stripeRequest(
        "customers",
        customerParams,
        `tenant-customer-${claims.tenantId}`,
      );
      customerId = customer.id;

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT id FROM tenants
          WHERE id = ${claims.tenantId}
          FOR UPDATE
        `);
        const subResult = await tx.execute(sql`
          SELECT stripe_customer_id AS "stripeCustomerId"
          FROM tenant_subscriptions
          WHERE tenant_id = ${claims.tenantId}
          FOR UPDATE
        `);
        const current = subResult.rows[0] as { stripeCustomerId?: string | null } | undefined;
        if (current?.stripeCustomerId && current.stripeCustomerId !== customerId) {
          throw new Error("Checkout customer identity conflict");
        }
        if (!current) throw new Error("TENANT_SUBSCRIPTION_MISSING");
        if (!current.stripeCustomerId) {
          await tx.update(tenantSubscriptions)
            .set({ stripeCustomerId: customerId, updatedAt: sql`clock_timestamp()` })
            .where(eq(tenantSubscriptions.tenantId, claims.tenantId));
        } else {
          customerId = current.stripeCustomerId;
        }
      });
    }

    const params = new URLSearchParams({ ...state.requestParams, customer: customerId });

    // Stamp the LAST external Checkout Session attempt before making it. If
    // the network/process loses the response, this timestamp becomes the
    // conservative recovery fence: we will not rotate the idempotency key
    // until a full maximum Stripe Checkout Session lifetime has elapsed.
    //
    // This is also a compare-and-set fence. A webhook or concurrent request
    // may have advanced the intent after the state transaction above; a stale
    // caller must not create/replay a Checkout Session after that transition.
    const attemptFence = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM tenants
        WHERE id = ${claims.tenantId}
        FOR UPDATE
      `);

      const touched = await tx.update(tenantSubscriptions)
        .set({ updatedAt: sql`clock_timestamp()` })
        .where(and(
          eq(tenantSubscriptions.tenantId, claims.tenantId),
          eq(tenantSubscriptions.checkoutIdempotencyKey, state.idempotencyKey),
          eq(tenantSubscriptions.checkoutStatus, "creating"),
        ))
        .returning({ id: tenantSubscriptions.tenantId });

      if (touched.length === 1) return { kind: "proceed" as const };

      const refreshed = await tx.query.tenantSubscriptions.findFirst({
        where: eq(tenantSubscriptions.tenantId, claims.tenantId),
        columns: {
          checkoutStatus: true,
          checkoutSessionUrl: true,
          stripeSubscriptionId: true,
        },
      });
      if (refreshed?.checkoutStatus === "open" && refreshed.checkoutSessionUrl) {
        return { kind: "existing" as const, url: refreshed.checkoutSessionUrl };
      }
      if (refreshed?.stripeSubscriptionId) return { kind: "completed" as const };
      return { kind: "changed" as const };
    });

    if (attemptFence.kind === "existing") {
      return NextResponse.json({ ok: true, url: attemptFence.url, existing: true });
    }
    if (attemptFence.kind === "completed") {
      return NextResponse.json({ error: "Checkout completed and the subscription is synchronizing." }, { status: 409 });
    }
    if (attemptFence.kind === "changed") {
      return NextResponse.json(
        { error: "Checkout state changed while preparing this request. Retry with the current workspace state.", code: "CHECKOUT_STATE_CHANGED" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    const session = await stripeRequest(
      "checkout/sessions",
      params,
      state.idempotencyKey,
    );
    if (typeof session.url !== "string" || !session.url) {
      throw new Error("Stripe checkout session did not return a redirect URL");
    }

    const sessionExpiresAt =
      typeof session.expires_at === "number"
        ? new Date(session.expires_at * 1000)
        : null;

    const finalized = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM tenants
        WHERE id = ${claims.tenantId}
        FOR UPDATE
      `);
      const current = await tx.execute(sql`
        SELECT status,
               checkout_status AS "checkoutStatus",
               stripe_subscription_id AS "stripeSubscriptionId"
        FROM tenant_subscriptions
        WHERE tenant_id = ${claims.tenantId}
        FOR UPDATE
      `);
      const row = current.rows[0] as {
        status?: string;
        checkoutStatus?: string;
        stripeSubscriptionId?: string | null;
      } | undefined;

      if (row?.stripeSubscriptionId && ACTIVE_SUBSCRIPTION_STATUSES.has(row.status ?? "")) {
        return { kind: "completed" as const };
      }

      const result = await tx.update(tenantSubscriptions)
        .set({
          checkoutStatus: "open",
          checkoutSessionId: session.id,
          checkoutSessionUrl: session.url,
          checkoutSessionExpiresAt: sessionExpiresAt,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(
          eq(tenantSubscriptions.tenantId, claims.tenantId),
          eq(tenantSubscriptions.checkoutIdempotencyKey, state.idempotencyKey),
          eq(tenantSubscriptions.checkoutStatus, "creating"),
        ))
        .returning({ id: tenantSubscriptions.tenantId });

      if (result.length !== 1) {
        const refreshed = await tx.query.tenantSubscriptions.findFirst({
          where: eq(tenantSubscriptions.tenantId, claims.tenantId),
          columns: {
            checkoutStatus: true,
            checkoutSessionUrl: true,
            stripeSubscriptionId: true,
          },
        });
        if (refreshed?.stripeSubscriptionId) return { kind: "completed" as const };
        if (refreshed?.checkoutSessionUrl) {
          return { kind: "existing" as const, url: refreshed.checkoutSessionUrl };
        }
      }
      return { kind: "open" as const };
    });

    if (finalized.kind === "completed") {
      return NextResponse.json({ error: "Checkout completed and the subscription is synchronizing." }, { status: 409 });
    }
    if (finalized.kind === "existing") {
      return NextResponse.json({ ok: true, url: finalized.url, existing: true });
    }
    return NextResponse.json({ ok: true, url: session.url });
  } catch (error) {
    // Preserve the creating intent for ambiguous/retryable Stripe failures: if
    // Stripe accepted the request but the response or local finalization was
    // lost, the next retry must replay the same idempotency key rather than
    // minting a second Checkout Session. A definitive Stripe 4xx, however,
    // proves the external mutation was rejected and must release the intent so
    // the workspace is not stranded on a permanently-invalid checkout.
    if (isDefinitiveStripeMutationError(error)) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT id
          FROM tenants
          WHERE id = ${claims.tenantId}
          FOR UPDATE
        `);
        await tx.update(tenantSubscriptions)
          .set({
            checkoutStatus: "none",
            checkoutPlanId: null,
            checkoutIdempotencyKey: null,
            checkoutRequestParams: null,
            checkoutIntentCreatedAt: null,
            checkoutSessionId: null,
            checkoutSessionUrl: null,
            checkoutSessionExpiresAt: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(
            eq(tenantSubscriptions.tenantId, claims.tenantId),
            eq(tenantSubscriptions.checkoutIdempotencyKey, state.idempotencyKey),
            eq(tenantSubscriptions.checkoutStatus, "creating"),
          ));
      });
      console.error("billing checkout rejected by Stripe", error.status, error.message);
      return NextResponse.json(
        { error: "Stripe rejected this checkout request. Correct the billing configuration and try again.", code: "STRIPE_CHECKOUT_REJECTED" },
        { status: 409 },
      );
    }

    const message = error instanceof Error ? error.message : "unknown";
    console.error("billing checkout failed", message);
    if (message === "Stripe is not configured") {
      return NextResponse.json(
        { error: "Stripe billing is not configured on this Gateway yet.", code: "STRIPE_NOT_CONFIGURED" },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "Checkout could not be created right now. Please retry." }, { status: 502 });
  }
}
