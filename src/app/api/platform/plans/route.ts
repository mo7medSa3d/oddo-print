import { assertWorkspaceSecurityOrigin,readWorkspaceSecurityJson } from "../../../../lib/workspace-session-http";
import { NextResponse } from "next/server";
import { asc,eq,sql } from "drizzle-orm";
import { db } from "../../../../db";
import { plans } from "../../../../db/schema";
import { requirePlatformOwner,requirePlatformActorInTransaction ,requirePlatformReadAuthorityInTransaction } from "../../../../lib/platform-auth";
import { manualApiError } from "../../../../lib/manual-api-error";
import { parseManualPlan } from "../../../../lib/manual-plans";
import { ManualSubscriptionError,requireIdempotencyKey,requestDigest } from "../../../../lib/manual-subscriptions";
import { writeAuditEvent } from "../../../../lib/audit";
export async function GET(req:Request) {
 try {
  const actor=await requirePlatformOwner(req);
  const rows=await db.transaction(async tx=>{
   await requirePlatformReadAuthorityInTransaction(tx,actor);
   return tx.select({
    id:plans.id,name:plans.name,description:plans.description,
    priceMinorUnits:plans.priceMinorUnits,priceCurrency:plans.priceCurrency,
    entitlements:plans.entitlements,isActive:plans.isActive,
    isPublic:plans.isPublic,displayOrder:plans.displayOrder,
   }).from(plans).orderBy(asc(plans.displayOrder),asc(plans.name));
  });
  return NextResponse.json({plans:rows},{headers:{'Cache-Control':'private, no-store'}});
 } catch(e) {
  const response=manualApiError(e);
  response.headers.set('Cache-Control','private, no-store');
  return response;
 }
}
export async function POST(req:Request) {
 try {
    assertWorkspaceSecurityOrigin(req);
  const actor=await requirePlatformOwner(req),key=requireIdempotencyKey(req);
  const raw=await readWorkspaceSecurityJson(req) as Record<string,unknown>;
  const plan=parseManualPlan(raw),digest=requestDigest(plan);
  await db.transaction(async tx=>{
   // One idempotency key is one operation for this Platform Owner, even if
   // raced requests carry DIFFERENT new plan IDs. Plan-ID locking alone allows
   // both transactions to observe no matching audit row and create two plans.
   // Acquire the actor+key lock first, then the existing plan-ID lock, so
   // identical retries serialize and divergent bodies return a conflict.
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'manual-plan:create:'+actor.userId+':'+key},0))`);
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'manual-plan:'+plan.id},0))`);
   await requirePlatformActorInTransaction(tx,actor);
   const previous=await tx.execute(sql`SELECT metadata FROM audit_events WHERE actor_type='platform' AND actor_id=${actor.userId} AND action='plan.created' AND request_id=${key} LIMIT 1`);
   if(previous.rows.length){if((previous.rows[0].metadata as {digest?:string}).digest!==digest)throw new ManualSubscriptionError('IDEMPOTENCY_CONFLICT',409);return;}
   if(await tx.query.plans.findFirst({where:eq(plans.id,plan.id)}))throw new ManualSubscriptionError('PLAN_EXISTS',409);
   await tx.insert(plans).values(plan);
   await writeAuditEvent({tenantId:null,actorType:'platform',actorId:actor.userId,action:'plan.created',resourceType:'plan',resourceId:plan.id,requestId:key,metadata:{after:plan,digest}},tx);
  });return NextResponse.json({ok:true,planId:plan.id},{status:201,headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return manualApiError(e);}
}
