import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantSubscriptions } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { stripeRequest } from "../../../../lib/stripe";

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "billing.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
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
    const portal = await stripeRequest(
      "billing_portal/sessions",
      new URLSearchParams({
        customer: sub.stripeCustomerId,
        return_url: base + "/billing",
      }),
      "portal-" + claims.tenantId,
    );

    if (typeof portal.url !== "string" || !portal.url) {
      return NextResponse.json({ error: "Stripe did not return a billing portal URL" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, url: portal.url });
  } catch (error) {
    console.error("billing portal failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: "Billing portal could not be opened right now. Please retry." },
      { status: 502 },
    );
  }
}
