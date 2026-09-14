import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { plans, tenantSubscriptions } from "../../../../db/schema";
import { and, eq } from "drizzle-orm";
import { validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";
import { runtimeSecret } from "../../../../lib/runtime-secret";
import { stripeRequest } from "../../../../lib/stripe";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
export async function POST(req:Request){
 if(hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({error:"Request body too large"},{status:413});
 const claims=await validateManager(req); if(!claims||!claims.userId||!hasManagerPermission(claims,"billing.manage"))return NextResponse.json({error:"Forbidden"},{status:403});
 let body:{planId?:unknown}= {}; try{body=await req.json()}catch{return NextResponse.json({error:"Invalid JSON"},{status:400});}
 const planId=typeof body.planId==="string"?body.planId:""; const plan=await db.query.plans.findFirst({where:eq(plans.id,planId)}); if(!plan?.stripePriceId)return NextResponse.json({error:"Plan is not billable"},{status:400});
 let sub=await db.query.tenantSubscriptions.findFirst({where:eq(tenantSubscriptions.tenantId,claims.tenantId)});
 if (sub?.stripeSubscriptionId && ["trialing", "active", "past_due", "paused"].includes(sub.status)) {
   return NextResponse.json({ error: "This workspace already has a Stripe subscription. Use the Customer Portal to change plans." }, { status: 409 });
 }
 let customerId=sub?.stripeCustomerId;
 if(!customerId){const f=new URLSearchParams({description:`Print Gateway tenant ${claims.tenantId}`,"metadata[tenant_id]":claims.tenantId});const c=await stripeRequest("customers",f,`tenant-customer-${claims.tenantId}`);customerId=c.id; await db.update(tenantSubscriptions).set({stripeCustomerId:customerId,updatedAt:new Date()}).where(eq(tenantSubscriptions.tenantId,claims.tenantId)); if(!sub){await db.insert(tenantSubscriptions).values({tenantId:claims.tenantId,planId,status:"cancelled",stripeCustomerId:customerId}); sub=await db.query.tenantSubscriptions.findFirst({where:eq(tenantSubscriptions.tenantId,claims.tenantId)});}}
 const base=(runtimeSecret("APP_BASE_URL")??new URL(req.url).origin).replace(/\/$/,"");
 const f=new URLSearchParams({mode:"subscription","customer":customerId!,"client_reference_id":claims.tenantId,"success_url":`${base}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,"cancel_url":`${base}/billing?checkout=cancelled`,"line_items[0][price]":plan.stripePriceId!,"line_items[0][quantity]":"1","subscription_data[metadata][tenant_id]":claims.tenantId,"subscription_data[metadata][plan_id]":plan.id});
 const session=await stripeRequest("checkout/sessions",f,`checkout-${claims.tenantId}-${plan.id}`);
 return NextResponse.json({ok:true,url:session.url});
}
