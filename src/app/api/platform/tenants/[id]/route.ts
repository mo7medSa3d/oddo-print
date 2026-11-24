import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "../../../../../db";
import { requirePlatformOwner, requirePlatformReadAuthorityInTransaction } from "../../../../../lib/platform-auth";
import { manualApiError } from "../../../../../lib/manual-api-error";
import { databaseNowMs } from "../../../../../lib/database-clock";
import { customerSubscriptionState,ManualSubscriptionError } from "../../../../../lib/manual-subscriptions";
import { quotaCycleEndSql } from "../../../../../lib/quota-cycle";
export async function GET(req:Request,context:{params:Promise<{id:string}>}) {
 try {
  const actor=await requirePlatformOwner(req);const {id}=await context.params;
  return await db.transaction(async tx=>{
   await requirePlatformReadAuthorityInTransaction(tx,actor);
  const workspace=await tx.execute(sql`SELECT t.*,u.id AS "ownerId",u.display_name AS "ownerName",u.email AS "ownerEmail",u.email_verified_at AS "ownerVerifiedAt" FROM tenants t LEFT JOIN tenant_users tu ON tu.tenant_id=t.id AND tu.role='owner' LEFT JOIN users u ON u.id=tu.user_id WHERE t.id=${id}`);
  if(!workspace.rows.length)throw new ManualSubscriptionError('WORKSPACE_NOT_FOUND',404);
  const [subscription,members,installations,credentials,events,history,requests]=await Promise.all([
   tx.execute(sql`SELECT s.tenant_id AS "tenantId",s.plan_id AS "planId",p.name AS "planName",s.status,s.entitlement_blocked AS "entitlementBlocked",s.subscription_type AS "subscriptionType",coalesce(s.monthly_quota,CASE WHEN p.entitlements->>'max_prints_per_period' ~ '^[0-9]{1,10}$' THEN CASE WHEN (p.entitlements->>'max_prints_per_period')::numeric BETWEEN 1 AND 2147483647 THEN (p.entitlements->>'max_prints_per_period')::int END ELSE NULL END) AS "monthlyQuota",s.term,s.current_period_start AS "currentPeriodStart",s.current_period_end AS "currentPeriodEnd",s.cancel_at_period_end AS "cancelAtPeriodEnd",s.internal_reference AS "internalReference",s.revision,0::int AS "monthlyUsed",(${quotaCycleEndSql()}) AT TIME ZONE 'UTC' AS "nextReset" FROM tenant_subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.tenant_id=${id}`),
   tx.execute(sql`SELECT u.id,u.display_name AS name,u.email,u.email_verified_at AS "verifiedAt",tu.role,(u.is_platform_owner AND u.email_verified_at IS NOT NULL) AS "isPlatformOwner" FROM tenant_users tu JOIN users u ON u.id=tu.user_id WHERE tu.tenant_id=${id} ORDER BY tu.created_at LIMIT 300`),
   tx.execute(sql`SELECT id,enabled,created_at AS "createdAt" FROM odoo_installations WHERE tenant_id=${id} ORDER BY created_at DESC LIMIT 300`),
   tx.execute(sql`SELECT id,name,created_at AS "createdAt",revoked_at AS "revokedAt",last_used_at AS "lastUsedAt" FROM api_keys WHERE tenant_id=${id} ORDER BY created_at DESC LIMIT 300`),
   tx.execute(sql`SELECT id,actor_id AS "actorId",action,created_at AS "createdAt" FROM audit_events WHERE tenant_id=${id} ORDER BY created_at DESC LIMIT 50`),
   tx.execute(sql`SELECT c.id,c.action,c.actor_id AS "actorId",u.email AS "actorEmail",c."before",c."after",c.reason,c.created_at AS "createdAt" FROM subscription_changes c LEFT JOIN users u ON u.id=c.actor_id WHERE c.tenant_id=${id} ORDER BY c.created_at DESC LIMIT 100`),
   tx.execute(sql`SELECT id,status,requester_user_id AS "requesterUserId",requester_name AS "requesterName",requester_email AS "requesterEmail",requester_verified_at AS "requesterVerifiedAt",plan_id AS "planId",term,requested_monthly_quota AS "requestedMonthlyQuota",approved_plan_id AS "approvedPlanId",approved_term AS "approvedTerm",approved_monthly_quota AS "approvedMonthlyQuota",approval_modified AS "approvalModified",created_at AS "createdAt",last_action_at AS "lastActionAt",last_action_reason AS "lastActionReason",subscription_revision AS "subscriptionRevision" FROM subscription_requests WHERE tenant_id=${id} ORDER BY created_at DESC LIMIT 100`),
  ]);
  const stored=subscription.rows[0] as {status:string;billingMode:string;currentPeriodStart:string;currentPeriodEnd:string|null;entitlementBlocked:boolean}|undefined;
  const databaseClock=new Date(await databaseNowMs());
   const effectiveStatus=customerSubscriptionState(stored,String(workspace.rows[0].lifecycle),databaseClock.getTime());
   const canReactivate=!!stored && stored.status==="suspended" &&
     customerSubscriptionState({...stored,status:"active",entitlementBlocked:false},
       String(workspace.rows[0].lifecycle),databaseClock.getTime()) === "active";
  const usage={today:0,month:0,year:0,monthlyHistory:[]};
  return NextResponse.json({workspace:workspace.rows[0],subscription:stored?{...stored,effectiveStatus,canReactivate}:null,members:members.rows,agents:[],printers:[],installations:installations.rows,credentials:credentials.rows,jobs:[],events:events.rows,history:history.rows,requests:requests.rows,usage},{headers:{'Cache-Control':'private, no-store'}});
  });
 }catch(e){const response=manualApiError(e);response.headers.set('Cache-Control','private, no-store');return response;}
}
