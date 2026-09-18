import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantSubscriptions, tenants } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { stripeRequest } from "../../../../lib/stripe";

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "billing.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  type OperationState =
    | { kind: "proceed"; operationId: string; idempotencyKey: string; subscriptionId: string }
    | { kind: "in_progress" }
    | { kind: "missing" };

  let state: OperationState;
  try {
    state = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id
        FROM tenants
        WHERE id = ${claims.tenantId}
        FOR UPDATE
      `);
      const result = await tx.execute(sql`
        SELECT stripe_subscription_id AS "stripeSubscriptionId",
               billing_operation_id AS "billingOperationId",
               billing_operation_type AS "billingOperationType",
               billing_operation_idempotency_key AS "billingOperationIdempotencyKey",
               billing_operation_subscription_id AS "billingOperationSubscriptionId"
        FROM tenant_subscriptions
        WHERE tenant_id = ${claims.tenantId}
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
          .where(eq(tenantSubscriptions.tenantId, claims.tenantId));
        row.billingOperationId = null;
        row.billingOperationType = null;
        row.billingOperationIdempotencyKey = null;
        row.billingOperationSubscriptionId = null;
      }

      if (row.billingOperationId) {
        if (
          row.billingOperationType !== "resume" ||
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
      const idempotencyKey = `billing-resume-${operationId}`;
      await tx.update(tenantSubscriptions)
        .set({
          billingOperationId: operationId,
          billingOperationType: "resume",
          billingOperationIdempotencyKey: idempotencyKey,
          billingOperationSubscriptionId: row.stripeSubscriptionId,
          updatedAt: new Date(),
        })
        .where(eq(tenantSubscriptions.tenantId, claims.tenantId));

      return {
        kind: "proceed" as const,
        operationId,
        idempotencyKey,
        subscriptionId: row.stripeSubscriptionId,
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "TENANT_NOT_FOUND") {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }
    throw error;
  }

  if (state.kind === "missing") {
    return NextResponse.json({ error: "No Stripe subscription" }, { status: 409 });
  }
  if (state.kind === "in_progress") {
    return NextResponse.json({ error: "Another billing operation is already in progress for this workspace." }, { status: 409 });
  }

  try {
    await stripeRequest(
      `subscriptions/${state.subscriptionId}`,
      new URLSearchParams({ cancel_at_period_end: "false" }),
      state.idempotencyKey,
    );
  } catch (error) {
    // Keep the persistent operation claim and its idempotency key. A retry
    // can safely replay the same Stripe request after a lost/ambiguous
    // response instead of issuing a second external mutation.
    console.error("billing resume failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Billing operation could not be completed right now. Please retry." }, { status: 502 });
  }

  try {
    const finalized = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id
        FROM tenants
        WHERE id = ${claims.tenantId}
        FOR UPDATE
      `);
      const result = await tx.execute(sql`
        SELECT stripe_subscription_id AS "stripeSubscriptionId",
               billing_operation_id AS "billingOperationId"
        FROM tenant_subscriptions
        WHERE tenant_id = ${claims.tenantId}
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
          .where(eq(tenantSubscriptions.tenantId, claims.tenantId));
        return { kind: "stale_identity" as const };
      }

      await tx.update(tenantSubscriptions)
        .set({
          cancelAtPeriodEnd: false,
          billingOperationId: null,
          billingOperationType: null,
          billingOperationIdempotencyKey: null,
          billingOperationSubscriptionId: null,
          updatedAt: new Date(),
        })
        .where(eq(tenantSubscriptions.tenantId, claims.tenantId));
      return { kind: "updated" as const };
    });

    if (finalized.kind === "stale_identity") {
      return NextResponse.json({ error: "Subscription identity changed while the billing operation was running; no stale local state was applied." }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("billing resume finalization failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Billing operation succeeded at Stripe but local state is still synchronizing. Retry safely." }, { status: 502 });
  }
}
