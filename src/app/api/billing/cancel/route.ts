import { NextResponse } from "next/server";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { runBillingOperation } from "../../../../lib/billing-operation";

export async function POST(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims?.userId || !hasManagerPermission(claims, "billing.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return runBillingOperation(claims.tenantId, {
    type: "cancel",
    missingSubscriptionError: "No active Stripe subscription",
    stripeParams: new URLSearchParams({ cancel_at_period_end: "true" }),
    cancelAtPeriodEnd: true,
    logLabel: "cancel",
  });
}
