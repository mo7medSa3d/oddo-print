import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { plans, tenantSubscriptions, tenants } from "../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { stripeRequest } from "../../../../lib/stripe";
import { hasBodyOverLimit } from "../../../../lib/request-limits";

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["trialing", "active", "past_due", "paused"]);

function checkoutIntentExpired(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) return false;
  if (expiresAt instanceof Date) return expiresAt.getTime() <= Date.now();
  // Raw-string fallback: naive PG timestamps parse as UTC, not host-local.
  let iso = expiresAt.replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) {
    iso += /[+-]\d{2}$/.test(iso) ? ":00" : "Z";
  }
  const value = Date.parse(iso);
  return Number.isFinite(value) && value <= Date.now();
}

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "billing.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { planId?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const plan = await db.query.plans.findFirst({ where: and(eq(plans.id, planId), eq(plans.isActive, true), eq(plans.isPublic, true)) });
  if (!plan?.stripePriceId) {
    return NextResponse.json({ error: "Plan is not billable" }, { status: 400 });
  }

  type CheckoutState =
    | { kind: "already_subscribed" }
    // An open, unexpired session for the SAME plan: replaying it and finding
    // one mid-flight are the same outcome, so one kind carries both.
    | { kind: "in_progress"; url?: string }
    | { kind: "plan_conflict"; openPlanId: string }
    | { kind: "proceed"; intentId: string; idempotencyKey: string; customerId: string | null };

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

      if (
        sub?.checkoutStatus === "creating" &&
        sub.checkoutPlanId &&
        sub.checkoutPlanId !== plan.id
      ) {
        // The pending intent may already exist as a live Checkout Session at
        // Stripe; it can never be superseded by a different plan here without
        // risking a double charge, so the caller must finish or let it expire.
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

      // A persisted "creating" intent is never replaced merely because the
      // original process disappeared. The same Stripe idempotency key is the
      // recovery fence: a retry may safely replay the exact external request,
      // including after an ambiguous timeout or process crash.
      if (
        sub?.checkoutStatus === "creating" &&
        sub.checkoutPlanId === plan.id &&
        sub.checkoutIdempotencyKey
      ) {
        return {
          kind: "proceed" as const,
          intentId: sub.checkoutIdempotencyKey.replace(/^checkout-intent-/, ""),
          idempotencyKey: sub.checkoutIdempotencyKey,
          customerId: sub.stripeCustomerId ?? null,
        };
      }

      const intentId = `chk_${randomUUID()}`;
      const idempotencyKey = `checkout-intent-${intentId}`;

      if (!sub) {
        await tx.insert(tenantSubscriptions).values({
          tenantId: claims.tenantId,
          planId: plan.id,
          status: "cancelled",
          checkoutStatus: "creating",
          checkoutPlanId: plan.id,
          checkoutIdempotencyKey: idempotencyKey,
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
              checkoutSessionId: null,
              checkoutSessionUrl: null,
              checkoutSessionExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(eq(tenantSubscriptions.tenantId, claims.tenantId));
        } else {
          return {
            kind: "proceed" as const,
            intentId: sub.checkoutIdempotencyKey.replace(/^checkout-intent-/, ""),
            idempotencyKey: sub.checkoutIdempotencyKey,
            customerId: sub.stripeCustomerId ?? null,
          };
        }
      }

      return {
        kind: "proceed" as const,
        intentId,
        idempotencyKey,
        customerId: sub?.stripeCustomerId ?? null,
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "TENANT_NOT_FOUND") {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }
    if (error instanceof Error && error.message === "TENANT_NOT_ACTIVE") {
      return NextResponse.json({ error: "Tenant is not active" }, { status: 409 });
    }
    throw error;
  }

  if (state.kind === "already_subscribed") {
    return NextResponse.json(
      { error: "This workspace already has a Stripe subscription. Use the Customer Portal to change plans." },
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

  let customerId = state.customerId;
  try {
    if (!customerId) {
      const customerParams = new URLSearchParams({
        description: `Print Gateway tenant ${claims.tenantId}`,
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
            .set({ stripeCustomerId: customerId, updatedAt: new Date() })
            .where(eq(tenantSubscriptions.tenantId, claims.tenantId));
        } else {
          customerId = current.stripeCustomerId;
        }
      });
    }

    const base = (runtimeSecret("APP_BASE_URL") ?? new URL(req.url).origin).replace(/\/$/, "");
    const params = new URLSearchParams({
      mode: "subscription",
      customer: customerId,
      client_reference_id: claims.tenantId,
      success_url: `${base}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/billing?checkout=cancelled`,
      "line_items[0][price]": plan.stripePriceId,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][tenant_id]": claims.tenantId,
      "subscription_data[metadata][plan_id]": plan.id,
    });

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
          updatedAt: new Date(),
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
    // Keep the intent in 'creating' with its original idempotency key. If
    // Stripe accepted the request but the response/DB finalization was lost,
    // the next retry safely replays the same external operation rather than
    // minting a second Checkout Session.
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
