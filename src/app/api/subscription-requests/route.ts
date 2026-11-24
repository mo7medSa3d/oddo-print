import { assertWorkspaceSecurityOrigin,readWorkspaceSecurityJson } from "../../../lib/workspace-session-http";
import { NextResponse } from "next/server";
import { and,desc,eq,sql } from "drizzle-orm";
import { db } from "../../../db";
import { plans,subscriptionRequests,tenantSubscriptions,tenants,users } from "../../../db/schema";
import { validateWorkspaceManager } from "../../../lib/manager-auth";
import { hasManagerPermission } from "../../../lib/authorization";
import { requireManagerActorInTransaction } from "../../../lib/manager-mutation-authorization";
import { requireActiveTenantInTransaction } from "../../../lib/tenant-guard";
import { customerSubscriptionState,ensurePendingManualSubscription,ManualSubscriptionError,requestDigest,requireIdempotencyKey } from "../../../lib/manual-subscriptions";
import { manualApiError } from "../../../lib/manual-api-error";
import { writeAuditEvent } from "../../../lib/audit";
import { nanoid } from "../../../lib/nanoid";
import { activationWhatsAppUrl } from "../../../lib/activation-contact";
import { parseDbTimeMs } from "../../../lib/database-timestamp";
import { computePlanTermPricing, evaluatePlanChangeEligibility } from "../../../lib/plan-price";
const safeRequest=(r:typeof subscriptionRequests.$inferSelect)=>({
  id:r.id,reference:r.id,status:r.status,createdAt:r.createdAt,
  planId:r.planId,term:r.term,requestedMonthlyQuota:r.requestedMonthlyQuota,
  approvedPlanId:r.approvedPlanId,approvedTerm:r.approvedTerm,
  approvedMonthlyQuota:r.approvedMonthlyQuota,approvalModified:r.approvalModified,
  whatsappUrl:activationWhatsAppUrl(r.id),
});
async function txNowMs(tx: { execute: typeof db.execute }): Promise<number> {
  const clock = await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms`);
  const value = Number((clock.rows[0] as { now_ms?: number | string } | undefined)?.now_ms);
  if (!Number.isFinite(value)) throw new Error("Database clock is unavailable");
  return value;
}
export async function GET(req:Request) {
  try {
    const actor=await validateWorkspaceManager(req);
    if (!actor) throw new ManualSubscriptionError("UNAUTHORIZED",401);
    if (!actor.userId || !hasManagerPermission(actor, "billing.read")) throw new ManualSubscriptionError("OWNER_REQUIRED",403);
    // Commercial details are owner-only. An initial cookie validation cannot
    // authorize an unfenced read after an owner downgrade, logout or suspension.
    // Recheck the durable member/session and tenant lifecycle in the same
    // transaction that reads contract dates and pending/approved requests.
    const [subscription,tenant,requests,nowMs]=await db.transaction(async tx=>{
      await requireActiveTenantInTransaction(tx,actor.tenantId);
      await requireManagerActorInTransaction(tx,actor,"billing.read");
      const subscription=await tx.query.tenantSubscriptions.findFirst({where:eq(tenantSubscriptions.tenantId,actor.tenantId)});
      const tenant=await tx.query.tenants.findFirst({where:eq(tenants.id,actor.tenantId)});
      const requests=await tx.query.subscriptionRequests.findMany({
        where:eq(subscriptionRequests.tenantId,actor.tenantId),
        orderBy:desc(subscriptionRequests.createdAt),limit:50,
      });
      return [subscription,tenant,requests,await txNowMs(tx)] as const;
    });
    const status=customerSubscriptionState(subscription,tenant?.lifecycle,nowMs);
    return NextResponse.json({requests:requests.map(safeRequest),status,hasSubscription:status==='active',planId:subscription?.planId??null,currentPeriodStart:subscription?.currentPeriodStart??null,currentPeriodEnd:subscription?.currentPeriodEnd??null},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return manualApiError(error);}
}
export async function POST(req:Request) {
  try {
    assertWorkspaceSecurityOrigin(req);
    const actor=await validateWorkspaceManager(req);
    if (!actor?.userId || actor.role!=='owner') throw new ManualSubscriptionError("OWNER_REQUIRED",403);
    const b=await readWorkspaceSecurityJson(req) as Record<string,unknown>;
    if (!b || typeof b.planId!=='string' || b.planId.length>100 || !['monthly','yearly','custom'].includes(String(b.term)) || (b.requestedMonthlyQuota!==undefined && (!Number.isSafeInteger(b.requestedMonthlyQuota)||Number(b.requestedMonthlyQuota)<1||Number(b.requestedMonthlyQuota)>2147483647)) || (b.quotedAmountMinorUnits!==undefined && (!Number.isSafeInteger(b.quotedAmountMinorUnits)||Number(b.quotedAmountMinorUnits)<0))) throw new ManualSubscriptionError("SUBSCRIPTION_INVALID");
    const input={planId:b.planId,term:String(b.term),requestedMonthlyQuota:b.requestedMonthlyQuota===undefined?null:Number(b.requestedMonthlyQuota)},key=requireIdempotencyKey(req),digest=requestDigest(input);
    const result=await db.transaction(async tx=>{
      await tx.execute(sql`SELECT id FROM tenants WHERE id=${actor.tenantId} FOR UPDATE`);
      await requireActiveTenantInTransaction(tx,actor.tenantId);
      await requireManagerActorInTransaction(tx,actor,"billing.read");
      const user=await tx.query.users.findFirst({where:eq(users.id,actor.userId!)});
      if (!user?.emailVerifiedAt) throw new ManualSubscriptionError("VERIFIED_OWNER_REQUIRED",403);
      const replay=await tx.query.subscriptionRequests.findFirst({where:and(eq(subscriptionRequests.tenantId,actor.tenantId),eq(subscriptionRequests.idempotencyKey,key))});
      if (replay) {
        if(replay.requestDigest!==digest||replay.requesterUserId!==actor.userId) throw new ManualSubscriptionError("IDEMPOTENCY_CONFLICT",409);
        const replayPlan=await tx.query.plans.findFirst({where:eq(plans.id,replay.planId)});
        const replayPricing=replayPlan && (replay.term==='monthly'||replay.term==='yearly')
          ? computePlanTermPricing(replayPlan.priceMinorUnits,replayPlan.priceCurrency,replay.term) : null;
        return {request:safeRequest(replay),pricing:replayPricing,replayed:true};
      }
      const pending=await tx.query.subscriptionRequests.findFirst({where:and(eq(subscriptionRequests.tenantId,actor.tenantId),eq(subscriptionRequests.status,'pending'))});
      if (pending) {
        // Do not acknowledge a different plan or term as a successful request.
        if (pending.requestDigest !== digest) {
          throw new ManualSubscriptionError("SUBSCRIPTION_REQUEST_ALREADY_PENDING",409);
        }
        const pendingPlan=await tx.query.plans.findFirst({where:eq(plans.id,pending.planId)});
        const pendingPricing=pendingPlan && (pending.term==='monthly'||pending.term==='yearly')
          ? computePlanTermPricing(pendingPlan.priceMinorUnits,pendingPlan.priceCurrency,pending.term) : null;
        return {request:safeRequest(pending),pricing:pendingPricing,replayed:true};
      }
      const plan=await tx.query.plans.findFirst({where:and(eq(plans.id,input.planId),eq(plans.isActive,true),eq(plans.isPublic,true))});
      if (!plan) throw new ManualSubscriptionError("PLAN_NOT_FOUND",404);
      if (input.term==='monthly'||input.term==='yearly') {
        const [currentSub,currentTenant,nowMs]=await Promise.all([
          tx.query.tenantSubscriptions.findFirst({where:eq(tenantSubscriptions.tenantId,actor.tenantId)}),
          tx.query.tenants.findFirst({where:eq(tenants.id,actor.tenantId),columns:{lifecycle:true}}),
          txNowMs(tx),
        ]);
        const currentStatus=customerSubscriptionState(currentSub,currentTenant?.lifecycle,nowMs);
        const periodEndMs=parseDbTimeMs(currentSub?.currentPeriodEnd);
        const expiringSoon=currentStatus==="active" && periodEndMs!==null && periodEndMs>nowMs && periodEndMs-nowMs<=7*86_400_000;
        const eligibility=evaluatePlanChangeEligibility({
          status:currentStatus,
          currentPlanId:currentSub?.planId??null,
          currentTerm:currentSub?.term??null,
          targetPlanId:plan.id,
          targetTerm:input.term,
          expiringSoon,
          pendingRequest:null,
        });
        if (!eligibility.allowed) {
          if (eligibility.reason==="already_on_yearly") throw new ManualSubscriptionError("SUBSCRIPTION_YEARLY_ACTIVE",409);
          throw new ManualSubscriptionError("SUBSCRIPTION_ALREADY_ACTIVE",409);
        }
      }
      const pricing=input.term==='monthly'||input.term==='yearly'
        ? computePlanTermPricing(plan.priceMinorUnits,plan.priceCurrency,input.term) : null;
      // Capture the plan's promised allowance when the request is submitted;
      // later catalog edits cannot silently rewrite what the customer asked for.
      const allowance=plan.entitlements.max_prints_per_period;
      const requestedMonthlyQuota=input.requestedMonthlyQuota ??
        (typeof allowance==="number" && Number.isSafeInteger(allowance) && allowance>0 ? allowance : null);
      await ensurePendingManualSubscription(tx,actor.tenantId,plan.id);
      const [request]=await tx.insert(subscriptionRequests).values({id:`req_${nanoid(24)}`,tenantId:actor.tenantId,requesterUserId:user.id,requesterName:user.displayName??'',requesterEmail:user.email,requesterVerifiedAt:user.emailVerifiedAt,...input,requestedMonthlyQuota,idempotencyKey:key,requestDigest:digest}).returning();
      await writeAuditEvent({tenantId:actor.tenantId,actorType:'user',actorId:user.id,action:'subscription.requested',resourceType:'subscription_request',resourceId:request.id,metadata:{...input,...(pricing?{quotedPricing:pricing}:{})}},tx);
      return {request:safeRequest(request),pricing,replayed:false};
    });
    return NextResponse.json({...result,whatsappUrl:result.request.whatsappUrl},{status:result.replayed?200:201,headers:{"Cache-Control":"private, no-store"}});
  } catch(error) {return manualApiError(error);}
}
