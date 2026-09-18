import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantSubscriptions, tenants } from "../../../../db/schema";
import { sql } from "drizzle-orm";
import { validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { stripeRequest } from "../../../../lib/stripe";

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "billing.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await db.transaction(async (tx) => {
      // Serialize billing identity changes with checkout and bind the Stripe
      // operation to the subscription row that was actually observed.
      await tx.execute(sql`SELECT id FROM tenants WHERE id = ${claims.tenantId} FOR UPDATE`);
      const subResult = await tx.execute(sql`
        SELECT stripe_subscription_id AS "stripeSubscriptionId"
        FROM tenant_subscriptions
        WHERE tenant_id = ${claims.tenantId}
        FOR UPDATE
      `);
      const sub = subResult.rows[0] as { stripeSubscriptionId?: string | null } | undefined;
      if (!sub?.stripeSubscriptionId) throw new Error("No active Stripe subscription");
      await stripeRequest(
        `subscriptions/${sub.stripeSubscriptionId}`,
        new URLSearchParams({ cancel_at_period_end: "true" }),
        `cancel-${sub.stripeSubscriptionId}`,
      );
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "No active Stripe subscription") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
