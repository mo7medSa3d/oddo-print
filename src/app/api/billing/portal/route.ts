import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../../lib/manager-mutation-authorization";
import { requireActiveTenantInTransaction } from "../../../../lib/tenant-guard";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantSubscriptions } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { stripeRequest } from "../../../../lib/stripe";

export async function POST(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasManagerPermission(claims, "billing.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // The provider call is outside any DB lock. Validate before the call and
    // again before disclosing its short-lived privileged portal URL.
    await db.transaction(async (tx) => {
      await requireActiveTenantInTransaction(tx, claims.tenantId);
      await requireManagerActorInTransaction(tx, claims, "billing.manage");
    });
    const sub = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, claims.tenantId),
      columns: {
        stripeCustomerId: true,
        stripeSubscriptionId: true,
      },
    });

    if (!sub?.stripeCustomerId) {
      return NextResponse.json({ error: "No billing customer exists yet" }, { status: 409 });
    }

    if (!sub.stripeSubscriptionId) {
      return NextResponse.json({ error: "No Stripe subscription is linked to this workspace yet" }, { status: 409 });
    }

    const base = (runtimeSecret("APP_BASE_URL") ?? new URL(req.url).origin).replace(/\/$/, "");
    // Portal sessions are short-lived (minutes). A static idempotency key would
    // cause Stripe to replay the same (now-expired) URL for 24h. Use a unique
    // key per request so each click mints a fresh portal session; retries with
    // the same key are still safe within a single logical operation.
    const portal = await stripeRequest(
      "billing_portal/sessions",
      new URLSearchParams({
        customer: sub.stripeCustomerId,
        return_url: base + "/billing",
      }),
      `portal-${claims.tenantId}-${randomUUID()}`,
    );

    if (typeof portal.url !== "string" || !portal.url) {
      return NextResponse.json({ error: "Stripe did not return a billing portal URL" }, { status: 502 });
    }

    await db.transaction(async (tx) => {
      await requireActiveTenantInTransaction(tx, claims.tenantId);
      await requireManagerActorInTransaction(tx, claims, "billing.manage");
    });
    return NextResponse.json({ ok: true, url: portal.url });
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) return NextResponse.json({ error: error.message }, { status: 403 });
    const message = error instanceof Error ? error.message : "unknown";
    console.error("billing portal failed", message);
    if (message === "Stripe is not configured") {
      return NextResponse.json(
        { error: "Stripe billing is not configured on this Gateway yet.", code: "STRIPE_NOT_CONFIGURED" },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Billing portal could not be opened right now. Please retry." },
      { status: 502 },
    );
  }
}
