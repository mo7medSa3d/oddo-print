import { assertWorkspaceSecurityOrigin,readWorkspaceSecurityJson } from "../../../../lib/workspace-session-http";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "../../../../db";
import { requirePlatformOwner,requirePlatformActorInTransaction,requirePlatformReadAuthorityInTransaction } from "../../../../lib/platform-auth";
import { manualApiError } from "../../../../lib/manual-api-error";
import { ManualSubscriptionError,requireIdempotencyKey } from "../../../../lib/manual-subscriptions";
import { writeAuditEvent } from "../../../../lib/audit";
import { effectiveSubscriptionStatusSql } from "../../../../lib/effective-subscription-status";
import { parseStrictListOffset } from "../../../../lib/request-limits";
export async function GET(req:Request) {
  try {
    const actor=await requirePlatformOwner(req);
    const params=new URL(req.url).searchParams;
    const status=params.get('status')??'pending';
    const offset=parseStrictListOffset(params.get('offset'),1_000_000);
    if(offset===null)throw new ManualSubscriptionError('INVALID_OFFSET',400);
    if(!['pending','approved','rejected','all'].includes(status))throw new ManualSubscriptionError('SUBSCRIPTION_INVALID');
    const [rows,counts]=await db.transaction(async tx=>{
      await requirePlatformReadAuthorityInTransaction(tx,actor);
      return Promise.all([
      tx.execute(sql`SELECT r.*,t.name AS "tenantName",p.name AS "planName",
        CASE WHEN p.entitlements->>'max_prints_per_period' ~ '^[0-9]{1,10}$'
          THEN CASE WHEN (p.entitlements->>'max_prints_per_period')::numeric BETWEEN 1 AND 2147483647
            THEN (p.entitlements->>'max_prints_per_period')::int END ELSE NULL END AS "planMonthlyQuota",
        current_plan.name AS "currentPlanName",
        ${effectiveSubscriptionStatusSql({tenantId:sql`t.id`,tenantLifecycle:sql`t.lifecycle`,subscriptionStatus:sql`current_sub.status`,entitlementBlocked:sql`current_sub.entitlement_blocked`,currentPeriodStart:sql`current_sub.current_period_start`})} AS "currentSubscriptionStatus"
        FROM subscription_requests r JOIN tenants t ON t.id=r.tenant_id
        JOIN plans p ON p.id=r.plan_id
        LEFT JOIN tenant_subscriptions current_sub ON current_sub.tenant_id=r.tenant_id
        LEFT JOIN plans current_plan ON current_plan.id=current_sub.plan_id
        WHERE (${status}='all' OR r.status=${status})
        ORDER BY r.created_at DESC,r.id DESC LIMIT 101 OFFSET ${offset}`),
      tx.execute(sql`SELECT count(*)::int AS pending FROM subscription_requests WHERE status='pending'`),
      ]);
    });
    return NextResponse.json({requests:rows.rows.slice(0,100),hasMore:rows.rows.length>100,offset,pendingCount:Number(counts.rows[0]?.pending??0)},{headers:{'Cache-Control':'private, no-store'}});
  } catch(error){return manualApiError(error);}
}
export async function POST(req:Request) {
  try {
    assertWorkspaceSecurityOrigin(req);
    const actor=await requirePlatformOwner(req),key=requireIdempotencyKey(req);
    const b=await readWorkspaceSecurityJson(req) as {id?:string;reason?:string};
    if(typeof b?.id!=='string'||typeof b?.reason!=='string'||!b.reason!.trim()||b.reason.length>500)throw new ManualSubscriptionError('SUBSCRIPTION_INVALID');
    await db.transaction(async tx=>{
      const identity=await tx.execute(sql`SELECT tenant_id FROM subscription_requests WHERE id=${b.id!}`);
      if(!identity.rows.length)throw new ManualSubscriptionError('SUBSCRIPTION_REQUEST_NOT_FOUND',404);
      const tenantId=String(identity.rows[0].tenant_id);
      // Same tenant -> subscription -> actor -> request order as approval.
      await tx.execute(sql`SELECT id FROM tenants WHERE id=${tenantId} FOR UPDATE`);
      await tx.execute(sql`SELECT tenant_id FROM tenant_subscriptions WHERE tenant_id=${tenantId} FOR UPDATE`);
      await requirePlatformActorInTransaction(tx,actor);
      const r=await tx.execute(sql`SELECT * FROM subscription_requests WHERE id=${b.id!} AND tenant_id=${tenantId} FOR UPDATE`);
      if(!r.rows.length)throw new ManualSubscriptionError('SUBSCRIPTION_REQUEST_NOT_FOUND',404);
      const prior=await tx.execute(sql`SELECT resource_id,metadata FROM audit_events WHERE actor_type='platform' AND actor_id=${actor.userId} AND action='subscription.request_rejected' AND request_id=${key} LIMIT 1`);
      if(prior.rows.length){
        if(prior.rows[0].resource_id!==b.id || (prior.rows[0].metadata as {reason?:string}).reason!==b.reason!.trim())throw new ManualSubscriptionError('IDEMPOTENCY_CONFLICT',409);
        return;
      }
      if(r.rows[0].status!=='pending')throw new ManualSubscriptionError('SUBSCRIPTION_REQUEST_CONFLICT',409);
      await tx.execute(sql`UPDATE subscription_requests SET status='rejected',last_action_by=${actor.userId},last_action_at=clock_timestamp(),last_action_reason=${b.reason!.trim()} WHERE id=${b.id!}`);
      await writeAuditEvent({tenantId:String(r.rows[0].tenant_id),actorType:'platform',actorId:actor.userId,action:'subscription.request_rejected',resourceType:'subscription_request',resourceId:b.id!,requestId:key,metadata:{reason:b.reason!.trim()}},tx);
    });
    return NextResponse.json({ok:true},{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){return manualApiError(error);}
}
