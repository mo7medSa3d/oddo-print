import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantSubscriptions } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { stripeRequest } from "../../../../lib/stripe";
export async function POST(req:Request){const claims=await validateManager(req);if(!claims||!claims.userId||!hasManagerPermission(claims,"billing.manage"))return NextResponse.json({error:"Forbidden"},{status:403});const sub=await db.query.tenantSubscriptions.findFirst({where:eq(tenantSubscriptions.tenantId,claims.tenantId)});if(!sub?.stripeSubscriptionId)return NextResponse.json({error:"No active Stripe subscription"},{status:409});await stripeRequest(`subscriptions/${sub.stripeSubscriptionId}`,new URLSearchParams({cancel_at_period_end:"true"}),`cancel-${sub.stripeSubscriptionId}`);return NextResponse.json({ok:true});}
