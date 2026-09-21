import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "../db";
import { tenantSubscriptions } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { stripeRequest } from "./stripe";

/**
 * Shared persistent billing-operation protocol for the two symmetric
 * subscription mutations (cancel-at-period-end / resume).
 *
 * Cancel and resume are one operation protocol with four deltas — the Stripe
 * form, the applied cancelAtPeriodEnd value, the no-subscription message, and
 * the log label. The concurrency fence (persistent operation claim, Stripe
 * idempotency key, stale-identity discard, guarded finalization) is identical
 * knowledge that must evolve in lockstep, so it lives here exactly once.
 *
 * Three phases, mirroring the checkout intent protocol:
 *  1. Claim (transaction): serialize on the tenant + subscription rows,
 *     discard a pending operation that targets a superseded subscription,
 *     reuse a matching pending operation's idempotency key, or mint and
 *     persist a new claim.
 *  2. Execute: replay-safe Stripe call under the persisted idempotency key.
 *     On failure the claim stays — a retry replays the same external request
 *     instead of issuing a second external mutation.
 *  3. Finalize (transaction): apply the local state flip only if this exact
 *     operation still owns the subscription identity; otherwise clear the
 *     stale claim without applying anything.
 */
export type BillingOperation = {
  type: "cancel" | "resume";
  /** Operator-facing message when the workspace has no Stripe subscription. */
  missingSubscriptionError: string;
  /** Query params for the Stripe subscriptions/{id} update call. */
  stripeParams: URLSearchParams;
  /** Local cancel_at_period_end value applied after Stripe confirms. */
  cancelAtPeriodEnd: boolean;
  /** Console log discriminator ("cancel" | "resume"). */
  logLabel: string;
};

type BillingOperationState =
  | { kind: "proceed"; operationId: string; idempotencyKey: string; subscriptionId: string }
  | { kind: "in_progress" }
  | { kind: "missing" };

export async function runBillingOperation(
  tenantId: string,
  operation: BillingOperation,
): Promise<NextResponse> {
  // Claim (transaction). An absent tenant simply yields no subscription row
  // and surfaces as the shared "missing" outcome below; nothing in this
  // transaction raises TENANT_NOT_FOUND (the earlier 404 mapping here was
  // dead code — that error name is only produced by checkout/onboarding/team
  // routes, which have their own handlers).
  const state: BillingOperationState = await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id
      FROM tenants
      WHERE id = ${tenantId}
      FOR UPDATE
    `);
    const result = await tx.execute(sql`
      SELECT stripe_subscription_id AS "stripeSubscriptionId",
             billing_operation_id AS "billingOperationId",
             billing_operation_type AS "billingOperationType",
             billing_operation_idempotency_key AS "billingOperationIdempotencyKey",
             billing_operation_subscription_id AS "billingOperationSubscriptionId"
      FROM tenant_subscriptions
      WHERE tenant_id = ${tenantId}
      FOR UPDATE
    `);
    const row = result.rows[0] as {
      stripeSubscriptionId?: string | null;
      billingOperationId?: string | null;
      billingOperationType?: string | null;
      billingOperationIdempotencyKey?: string | null;
      billingOperationSubscriptionId?: string | null;
    } | undefined;

    if (!row?.stripeSubscriptionId) return { kind: "missing" as const };

    // A completed webhook can replace the subscription identity while an
    // older process is still finalizing. A pending operation targeting a
    // different Stripe subscription is stale and may safely be discarded.
    if (
      row.billingOperationId &&
      row.billingOperationSubscriptionId &&
      row.billingOperationSubscriptionId !== row.stripeSubscriptionId
    ) {
      await tx.update(tenantSubscriptions)
        .set({
          billingOperationId: null,
          billingOperationType: null,
          billingOperationIdempotencyKey: null,
          billingOperationSubscriptionId: null,
          updatedAt: new Date(),
        })
        .where(eq(tenantSubscriptions.tenantId, tenantId));
      row.billingOperationId = null;
      row.billingOperationType = null;
      row.billingOperationIdempotencyKey = null;
      row.billingOperationSubscriptionId = null;
    }

    if (row.billingOperationId) {
      if (
        row.billingOperationType !== operation.type ||
        !row.billingOperationIdempotencyKey ||
        !row.billingOperationSubscriptionId
      ) {
        return { kind: "in_progress" as const };
      }
      return {
        kind: "proceed" as const,
        operationId: row.billingOperationId,
        idempotencyKey: row.billingOperationIdempotencyKey,
        subscriptionId: row.billingOperationSubscriptionId,
      };
    }

    const operationId = `billop_${randomUUID()}`;
    const idempotencyKey = `billing-${operation.type}-${operationId}`;
    await tx.update(tenantSubscriptions)
      .set({
        billingOperationId: operationId,
        billingOperationType: operation.type,
        billingOperationIdempotencyKey: idempotencyKey,
        billingOperationSubscriptionId: row.stripeSubscriptionId,
        updatedAt: new Date(),
      })
      .where(eq(tenantSubscriptions.tenantId, tenantId));

    return {
      kind: "proceed" as const,
      operationId,
      idempotencyKey,
      subscriptionId: row.stripeSubscriptionId,
    };
  });

  if (state.kind === "missing") {
    return NextResponse.json({ error: operation.missingSubscriptionError }, { status: 409 });
  }
  if (state.kind === "in_progress") {
    return NextResponse.json({ error: "Another billing operation is already in progress for this workspace." }, { status: 409 });
  }

  try {
    await stripeRequest(
      `subscriptions/${state.subscriptionId}`,
      operation.stripeParams,
      state.idempotencyKey,
    );
  } catch (error) {
    // Keep the persistent operation claim and its idempotency key. A retry
    // can safely replay the same Stripe request after a lost/ambiguous
    // response instead of issuing a second external mutation.
    console.error(`billing ${operation.logLabel} failed`, error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Billing operation could not be completed right now. Please retry." }, { status: 502 });
  }

  try {
    const finalized = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id
        FROM tenants
        WHERE id = ${tenantId}
        FOR UPDATE
      `);
      const result = await tx.execute(sql`
        SELECT stripe_subscription_id AS "stripeSubscriptionId",
               billing_operation_id AS "billingOperationId"
        FROM tenant_subscriptions
        WHERE tenant_id = ${tenantId}
        FOR UPDATE
      `);
      const row = result.rows[0] as {
        stripeSubscriptionId?: string | null;
        billingOperationId?: string | null;
      } | undefined;

      if (row?.billingOperationId !== state.operationId) {
        return { kind: "already_finalized" as const };
      }
      if (row.stripeSubscriptionId !== state.subscriptionId) {
        await tx.update(tenantSubscriptions)
          .set({
            billingOperationId: null,
            billingOperationType: null,
            billingOperationIdempotencyKey: null,
            billingOperationSubscriptionId: null,
            updatedAt: new Date(),
          })
          .where(eq(tenantSubscriptions.tenantId, tenantId));
        return { kind: "stale_identity" as const };
      }

      await tx.update(tenantSubscriptions)
        .set({
          cancelAtPeriodEnd: operation.cancelAtPeriodEnd,
          billingOperationId: null,
          billingOperationType: null,
          billingOperationIdempotencyKey: null,
          billingOperationSubscriptionId: null,
          updatedAt: new Date(),
        })
        .where(eq(tenantSubscriptions.tenantId, tenantId));
      return { kind: "updated" as const };
    });

    if (finalized.kind === "stale_identity") {
      return NextResponse.json({ error: "Subscription identity changed while the billing operation was running; no stale local state was applied." }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`billing ${operation.logLabel} finalization failed`, error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Billing operation succeeded at Stripe but local state is still synchronizing. Retry safely." }, { status: 502 });
  }
}
