import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantSubscriptions } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { stripeRequest } from "../../../../lib/stripe";
export async function POST(req:Request){const claims=await validateManager(req);if(!claims||!claims.userId||!hasManagerPermission(claims,"billing.manage"))return NextResponse.json({error:"Forbidden"},{status:403});const sub=await db.query.tenantSubscriptions.findFirst({where:eq(tenantSubscriptions.tenantId,claims.tenantId)});if(!sub?.stripeCustomerId)return NextResponse.json({error:"No billing customer exists yet"},{status:409});const base=(runtimeSecret("APP_BASE_URL")??new URL(req.url).origin).replace(/\/$/,"");const f=new URLSearchParams({customer:sub.stripeCustomerId,return_url:`${base}/billing`});const portal=await stripeRequest("billing_portal/sessions",f,`portal-${claims.tenantId}`);return NextResponse.json({ok:true,url:portal.url});}
