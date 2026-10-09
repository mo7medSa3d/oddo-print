import { ManagerMutationAuthorityChangedError } from "../../../../lib/manager-mutation-authorization";
import { NextResponse } from "next/server";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { runBillingOperation } from "../../../../lib/billing-operation";

export async function POST(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasManagerPermission(claims, "billing.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try { return await runBillingOperation(claims, {
    type: "cancel",
    missingSubscriptionError: "No active Stripe subscription",
    stripeParams: new URLSearchParams({ cancel_at_period_end: "true" }),
    cancelAtPeriodEnd: true,
    logLabel: "cancel",
  }); } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
}
