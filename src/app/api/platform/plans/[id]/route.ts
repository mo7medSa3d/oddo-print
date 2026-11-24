import { assertWorkspaceSecurityOrigin,readWorkspaceSecurityJson } from "../../../../../lib/workspace-session-http";
import { NextResponse } from "next/server";
import { eq,sql } from "drizzle-orm";
import { db } from "../../../../../db";
import { plans } from "../../../../../db/schema";
import { requirePlatformOwner,requirePlatformActorInTransaction } from "../../../../../lib/platform-auth";
import { manualApiError } from "../../../../../lib/manual-api-error";
import { parseManualPlan } from "../../../../../lib/manual-plans";
import { ManualSubscriptionError,requireIdempotencyKey,requestDigest } from "../../../../../lib/manual-subscriptions";
import { writeAuditEvent } from "../../../../../lib/audit";
export async function PATCH(req:Request,context:{params:Promise<{id:string}>}) {
 try {
    assertWorkspaceSecurityOrigin(req);
  const actor=await requirePlatformOwner(req),key=requireIdempotencyKey(req),{id}=await context.params;
  const raw=await readWorkspaceSecurityJson(req);
  // JSON null and arrays are valid JSON, but not editable plan objects.
  // Reject them as client errors before dereferencing priceAmount.
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new ManualSubscriptionError('PLAN_INVALID');
  const payload=raw as Record<string,unknown>;
  const priceProvided = payload.priceAmount !== undefined || payload.priceCurrency !== undefined;
  const isActiveProvided=payload.isActive!==undefined,isPublicProvided=payload.isPublic!==undefined,displayOrderProvided=payload.displayOrder!==undefined,maxAgentsProvided=payload.maxAgents!==undefined,maxPrintersProvided=payload.maxPrinters!==undefined;
  const plan=parseManualPlan({...payload,id}),legacyDigest=requestDigest({plan,priceProvided}),digest=requestDigest({plan,priceProvided,isActiveProvided,isPublicProvided,displayOrderProvided,maxAgentsProvided,maxPrintersProvided});
  await db.transaction(async tx=>{
   // A single Platform Owner operation key cannot edit two different plans
   // concurrently. Acquire the actor+key lock before the resource lock so
   // the second request observes the first audit digest and fails with 409.
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'manual-plan:update:'+actor.userId+':'+key},0))`);
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'manual-plan:'+id},0))`);
   await tx.execute(sql`SELECT id FROM plans WHERE id=${id} FOR UPDATE`);
   await requirePlatformActorInTransaction(tx,actor);
   const previous=await tx.execute(sql`SELECT metadata FROM audit_events WHERE actor_type='platform' AND actor_id=${actor.userId} AND action='plan.updated' AND request_id=${key} LIMIT 1`);
   if(previous.rows.length){const previousDigest=(previous.rows[0].metadata as {digest?:string}).digest;if(previousDigest!==digest&&previousDigest!==legacyDigest)throw new ManualSubscriptionError('IDEMPOTENCY_CONFLICT',409);return;}
   const before=await tx.query.plans.findFirst({where:eq(plans.id,id)});
   if(!before)throw new ManualSubscriptionError('PLAN_NOT_FOUND',404);
   const entitlements = {
     ...before.entitlements,
     max_prints_per_period: plan.entitlements.max_prints_per_period,
     ...(maxAgentsProvided ? { max_agents: plan.entitlements.max_agents } : {}),
     ...(maxPrintersProvided ? { max_printers: plan.entitlements.max_printers } : {}),
   };
   // Legacy catalog clients that omit price must not accidentally erase it.
   // Explicit null/null clears the advertised price.
   const priceFields = priceProvided
     ? {priceMinorUnits:plan.priceMinorUnits,priceCurrency:plan.priceCurrency}
     : {priceMinorUnits:before.priceMinorUnits,priceCurrency:before.priceCurrency};
   const catalogFields={...plan,isActive:isActiveProvided?plan.isActive:before.isActive,isPublic:isPublicProvided?plan.isPublic:before.isPublic,displayOrder:displayOrderProvided?plan.displayOrder:before.displayOrder};
   await tx.update(plans).set({...catalogFields,...priceFields,entitlements,updatedAt:sql`clock_timestamp()`}).where(eq(plans.id,id));
   await writeAuditEvent({tenantId:null,actorType:'platform',actorId:actor.userId,action:'plan.updated',resourceType:'plan',resourceId:id,requestId:key,metadata:{before:{name:before.name,entitlements:before.entitlements,isActive:before.isActive,isPublic:before.isPublic,priceMinorUnits:before.priceMinorUnits,priceCurrency:before.priceCurrency},after:{...catalogFields,...priceFields,entitlements},digest}},tx);
  });return NextResponse.json({ok:true},{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return manualApiError(e);}
}
