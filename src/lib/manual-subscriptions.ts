import { parseDbTimeMs } from "./database-timestamp";
import { createHash } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db, type DbTx } from "../db";
import { plans, subscriptionChanges, subscriptionRequests, tenantSubscriptions } from "../db/schema";
import { nanoid } from "./nanoid";
import { writeAuditEvent } from "./audit";
import { requirePlatformActorInTransaction, type PlatformOwnerClaims } from "./platform-auth";
import { normalizePlanEntitlements } from "./entitlements";
import { z } from "zod";

export class ManualSubscriptionError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
export function requestDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function requireIdempotencyKey(req: Request): string {
  const key = req.headers.get("idempotency-key") ?? "";
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new ManualSubscriptionError("IDEMPOTENCY_KEY_REQUIRED");
  return key;
}
export function customerSubscriptionState(sub: {status: string; currentPeriodStart: Date | string; currentPeriodEnd: Date | string | null; entitlementBlocked?: boolean} | null | undefined, lifecycle = "active", now = Date.now()): "awaiting_activation" | "active" | "expired" | "suspended" {
  if (lifecycle !== "active" || sub?.status === "suspended" || sub?.entitlementBlocked) return "suspended";
  if (!sub || sub.status === "awaiting_activation" || (parseDbTimeMs(sub.currentPeriodStart) ?? Infinity) > now) return "awaiting_activation";
  if (sub.status !== "active" || !sub.currentPeriodEnd || (parseDbTimeMs(sub.currentPeriodEnd) ?? -Infinity) <= now) return "expired";
  return "active";
}
/** PostgreSQL timestamps without a zone are UTC in this application.
 * Convert through the shared database parser: new Date(rawSQLString) would
 * interpret naive clock strings in the Node host's local timezone. */
export function manualReactivationDeadlineLive(
  expiry: Date | string | null, databaseClock: Date | string | null,
): boolean {
  const nowMs = parseDbTimeMs(databaseClock);
  const expiryMs = parseDbTimeMs(expiry);
  return nowMs !== null && expiryMs !== null && expiryMs > nowMs;
}
export async function ensurePendingManualSubscription(tx: DbTx, tenantId: string, planId: string): Promise<void> {
  await tx.insert(tenantSubscriptions).values({tenantId,planId,status:"awaiting_activation",subscriptionType:"paid"}).onConflictDoNothing();
}
type ManualSubscriptionInput = {
  action: "save" | "renew" | "extend" | "suspend" | "reactivate" | "cancel_at_end" | "revoke";
  expectedRevision: number;
  planId?: string;
  subscriptionType?: "free" | "paid";
  monthlyQuota?: number;
  term?: "monthly" | "yearly" | "custom";
  startDate?: string;
  endDate?: string;
  status?: "active" | "awaiting_activation";
  reason: string;
  internalReference?: string;
  requestId?: string;
  allowRequestChanges?: boolean;
};
/** Contract months are calendar months, never 30-day blocks. Keep the approval
 * instant (hour/minute included), clamping 31st and leap days at month-end. */
export function endOfCalendarTermUTC(start: Date, term: "monthly" | "yearly"): Date {
  const end = new Date(start.getTime());
  if (!Number.isFinite(end.getTime())) throw new ManualSubscriptionError("SUBSCRIPTION_DATES_INVALID");
  const dayOfMonth = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + (term === "monthly" ? 1 : 12));
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(dayOfMonth, lastDay));
  return end;
}
// Date.parse accepts rolled-over calendar dates and host-local timestamps.
// Contracts need an actual calendar date with an explicit timezone before a
// Date is constructed or persisted. Keep valid ISO instants from existing API
// clients, including offsets, rather than silently changing their terms.
const subscriptionDate = z.iso.datetime({ offset: true }).max(100);
export function parseManualSubscriptionInput(value: unknown): ManualSubscriptionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManualSubscriptionError("SUBSCRIPTION_INVALID");
  const b = value as Record<string, unknown>;
  if (typeof b.action!=="string" || !["save","renew","extend","suspend","reactivate","cancel_at_end","revoke"].includes(b.action) || !Number.isSafeInteger(b.expectedRevision) || Number(b.expectedRevision)<0) throw new ManualSubscriptionError("SUBSCRIPTION_INVALID");
  if (typeof b.reason!=="string" || !b.reason.trim() || b.reason.length>500) throw new ManualSubscriptionError("SUBSCRIPTION_REASON_REQUIRED");
  for (const key of ["internalReference","requestId","planId"] as const) if (b[key]!==undefined && (typeof b[key]!=="string" || b[key].length>200)) throw new ManualSubscriptionError("SUBSCRIPTION_INVALID");
  if (b.allowRequestChanges !== undefined && typeof b.allowRequestChanges !== "boolean") throw new ManualSubscriptionError("SUBSCRIPTION_INVALID");
  if (b.allowRequestChanges === true && (!b.requestId || !["save","renew"].includes(String(b.action)))) throw new ManualSubscriptionError("SUBSCRIPTION_INVALID");
  if (["save","renew"].includes(b.action)) {
    if (typeof b.planId!=="string" || typeof b.subscriptionType!=="string" || !["free","paid"].includes(b.subscriptionType) || typeof b.term!=="string" || !["monthly","yearly","custom"].includes(b.term) || !Number.isSafeInteger(b.monthlyQuota) || Number(b.monthlyQuota)<1 || Number(b.monthlyQuota)>2147483647 || typeof b.status!=="string" || !["active","awaiting_activation"].includes(b.status)) throw new ManualSubscriptionError("SUBSCRIPTION_INVALID");
    if (!subscriptionDate.safeParse(b.startDate).success) throw new ManualSubscriptionError("SUBSCRIPTION_DATES_INVALID");
  }
  if (["save","renew","extend"].includes(b.action)) {
    if (!subscriptionDate.safeParse(b.endDate).success) throw new ManualSubscriptionError("SUBSCRIPTION_DATES_INVALID");
    if (b.startDate && Date.parse(String(b.endDate))<=Date.parse(String(b.startDate))) throw new ManualSubscriptionError("SUBSCRIPTION_DATES_INVALID");
  }
  return {...b,reason:b.reason.trim()} as ManualSubscriptionInput;
}
function publicSnapshot(row: typeof tenantSubscriptions.$inferSelect | null): Record<string, unknown> | null {
  if (!row) return null;
  return {planId:row.planId,status:row.status,subscriptionType:row.subscriptionType,monthlyQuota:row.monthlyQuota,term:row.term,currentPeriodStart:row.currentPeriodStart.toISOString(),currentPeriodEnd:row.currentPeriodEnd?.toISOString()??null,printCycleAnchor:row.printCycleAnchor?.toISOString()??null,cancelAtPeriodEnd:row.cancelAtPeriodEnd,internalReference:row.internalReference,revision:row.revision,entitlementBlocked:row.entitlementBlocked,entitlementBlockedReason:row.entitlementBlockedReason,revokedAt:row.revokedAt?.toISOString()??null,revokedReason:row.revokedReason}; // v3 (0108)
}
/** Resource -> subscription -> actor lock order matches runtime admission fences. */
export async function mutateManualSubscription(tenantId: string, actor: PlatformOwnerClaims, key: string, input: ManualSubscriptionInput) {
  const digest=requestDigest(input);
  return db.transaction(async tx => {
    const tenant=await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`);
    if (!tenant.rows.length || tenant.rows[0].lifecycle==='deleted') throw new ManualSubscriptionError("WORKSPACE_NOT_FOUND",404);
    await tx.execute(sql`SELECT tenant_id FROM tenant_subscriptions WHERE tenant_id=${tenantId} FOR UPDATE`);
    await requirePlatformActorInTransaction(tx,actor);
    const previous=await tx.query.subscriptionChanges.findFirst({where:and(eq(subscriptionChanges.tenantId,tenantId),eq(subscriptionChanges.idempotencyKey,key))});
    if (previous) {
      if (previous.requestDigest!==digest || previous.actorId!==actor.userId) throw new ManualSubscriptionError("IDEMPOTENCY_CONFLICT",409);
      return {subscription:previous.after,replayed:true};
    }
    // A linked approval preserves the original customer intent; a Platform
    // Owner may explicitly approve different terms, with a separate snapshot.
    // Unrelated subscription changes may still be made without a requestId.
    let requestApproval: {planId:string;term:string;monthlyQuota:number|null;modified:boolean}|null=null;
    if (input.requestId) {
      if ((input.action !== "save" && input.action !== "renew") || input.status !== "active") {
        throw new ManualSubscriptionError("SUBSCRIPTION_REQUEST_CONFLICT",409);
      }
      const request=await tx.execute(sql`SELECT plan_id AS "planId",term,requested_monthly_quota AS "requestedMonthlyQuota"
        FROM subscription_requests WHERE id=${input.requestId} AND tenant_id=${tenantId} AND status='pending' FOR UPDATE`);
      const requested=request.rows[0];
      if (!requested) throw new ManualSubscriptionError("SUBSCRIPTION_REQUEST_CONFLICT",409);
      const requestedQuota = requested.requestedMonthlyQuota===null ? null : Number(requested.requestedMonthlyQuota);
      const modified = input.planId !== requested.planId || input.term !== requested.term ||
        input.monthlyQuota !== requestedQuota;
      if (modified && input.allowRequestChanges !== true) {
        throw new ManualSubscriptionError("SUBSCRIPTION_REQUEST_TERMS_MISMATCH",409);
      }
      if (modified && input.reason.trim().length < 10) {
        throw new ManualSubscriptionError("SUBSCRIPTION_REASON_REQUIRED",400);
      }
      requestApproval = {planId:String(requested.planId),term:String(requested.term),monthlyQuota:requestedQuota,modified};
    }
    const before=await tx.query.tenantSubscriptions.findFirst({where:eq(tenantSubscriptions.tenantId,tenantId)});
    if ((before?.revision??0)!==input.expectedRevision) throw new ManualSubscriptionError("SUBSCRIPTION_REVISION_CONFLICT",409);
    let changes: Partial<typeof tenantSubscriptions.$inferInsert>={revision:(before?.revision??0)+1};
    // Revocation timestamp is a DB-clock SQL value, which $inferInsert
    // (Date) cannot hold. It is set only in the else-branch (before must
    // exist), so it flows exclusively to the update path below, never to
    // insert values. Keep it out of `changes` for that reason.
    let revokedAtSql: SQL | null = null;
    // Only a successfully approved, linked customer request fixes the term
    // start from the authoritative database clock, not the request's creation
    // date, browser time, or a stale admin form. Keep one timestamp for the
    // contract start and approval audit event.
    let approvedAt: Date | null = null;
    if (input.action==='save'||input.action==='renew') {
      const plan=await tx.query.plans.findFirst({where:and(eq(plans.id,input.planId!),eq(plans.isActive,true))});
      if (!plan) throw new ManualSubscriptionError("PLAN_NOT_FOUND",404);
      normalizePlanEntitlements(plan.entitlements);
      let start=new Date(input.startDate!), end=new Date(input.endDate!);
      if (input.requestId) {
        const clock = await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS "approvalMs"`);
        const approvalMs = Number(clock.rows[0]?.approvalMs);
        if (!Number.isFinite(approvalMs)) throw new ManualSubscriptionError("SUBSCRIPTION_DATES_INVALID");
        approvedAt = new Date(approvalMs);
        if (input.action === 'save') {
          start = approvedAt;
          // Custom contracts retain the explicitly agreed deadline; automatic
          // monthly/yearly contracts get their full duration after approval.
          if (input.term !== 'custom') end = endOfCalendarTermUTC(start, input.term!);
        } else if (input.term !== 'custom' && before?.currentPeriodEnd) {
          // Renewals preserve time already paid for. When the old term has
          // elapsed, count the renewed term from this actual approval instead.
          const base = before.currentPeriodEnd > approvedAt ? before.currentPeriodEnd : approvedAt;
          end = endOfCalendarTermUTC(base, input.term!);
        }
      }
      if (end <= start) throw new ManualSubscriptionError("SUBSCRIPTION_DATES_INVALID");
      if (input.action==='renew' && (!before || !before.currentPeriodEnd || end<=before.currentPeriodEnd)) throw new ManualSubscriptionError("SUBSCRIPTION_DATES_INVALID");
      // A renewal extends the same contract and retains original start; it never
      // replaces or resets the independent UTC calendar-month allowance ledger.
      // Retain the historical first-activation anchor for migration/audit only;
      // the quota ledger now uses UTC calendar-month boundaries (0102).
      const firstActivation = input.status === 'active' && (!before || before.status === 'awaiting_activation');
      let cycleAnchor = before?.printCycleAnchor ?? null;
      if (firstActivation && !cycleAnchor) {
        const clock = approvedAt ?? new Date(Number((await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS ms`)).rows[0]?.ms));
        if (!Number.isFinite(clock.getTime())) throw new ManualSubscriptionError("SUBSCRIPTION_DATES_INVALID");
        cycleAnchor = new Date(Math.max(clock.getTime(), start.getTime()));
      }
      changes={...changes,planId:plan.id,subscriptionType:input.subscriptionType,monthlyQuota:input.monthlyQuota,term:input.term,currentPeriodStart:input.action==='renew'?before!.currentPeriodStart:start,currentPeriodEnd:end,status:input.status,cancelAtPeriodEnd:false,entitlementBlocked:false,entitlementBlockedReason:null,internalReference:input.internalReference||null,...(cycleAnchor ? {printCycleAnchor:cycleAnchor} : {}),
        // v3 (0108): save/renew is a new contract approved by the platform
        // owner, so it clears a previous revocation. Reactivation of the
        // revoked contract itself stays blocked (see reactivate below).
        revokedAt:null,revokedReason:null};
    } else {
      if (!before) throw new ManualSubscriptionError("SUBSCRIPTION_NOT_FOUND",404);
      if (input.action==='extend') {
        // v3 (0108): extending a revoked contract would reopen its
        // reactivation deadline; a new contract needs save/renew instead.
        if (before.revokedAt) throw new ManualSubscriptionError("SUBSCRIPTION_REVOKED",409);
        const end=new Date(input.endDate!);
        if (end<=before.currentPeriodStart || (before.currentPeriodEnd && end<=before.currentPeriodEnd)) throw new ManualSubscriptionError("SUBSCRIPTION_DATES_INVALID");
        // v3 (PASS 4): extending a derived-expired contract (stored active,
        // period end already past) is a reactivation by another name: it
        // must pass the reactivate guards (active workspace + period end
        // still live), otherwise a new contract needs save/renew. Suspended
        // contracts are unaffected (extend does not change status, so they
        // stay suspended), and legacy null-end rows are unaffected (no past
        // end exists to expire against — setting the first end completes
        // the contract rather than reviving it).
        if (before.status==='active' && before.currentPeriodEnd) {
          const nowRow=await tx.execute(sql`SELECT clock_timestamp() AS now`);
          const liveNow=nowRow.rows[0]?.now as Date | string | null;
          const endMs=parseDbTimeMs(before.currentPeriodEnd);
          const nowMs=parseDbTimeMs(liveNow);
          if (endMs!==null && nowMs!==null && endMs<=nowMs) {
            if (tenant.rows[0].lifecycle !== 'active') throw new ManualSubscriptionError("WORKSPACE_NOT_ACTIVE",409);
            if (!manualReactivationDeadlineLive(before.currentPeriodEnd,liveNow)) throw new ManualSubscriptionError("SUBSCRIPTION_EXPIRED",409);
          }
        }
        changes.currentPeriodEnd=end;
      }
      if (input.action==='suspend') changes.status='suspended';
      if (input.action==='revoke') {
        // v3 (0108): revoke was previously identical to suspend (status
        // only), so any later reactivate within the term silently undid it.
        // The revoked marker makes revocation terminal for this contract;
        // the quota ledger is untouched (suspension already blocks use).
        changes.status='suspended'; revokedAtSql=sql`clock_timestamp()`; changes.revokedReason=input.reason || null;
      }
      if (input.action==='reactivate') {
        if (before.revokedAt) throw new ManualSubscriptionError("SUBSCRIPTION_REVOKED",409);
        if (before.status!=='suspended') throw new ManualSubscriptionError('SUBSCRIPTION_REQUEST_CONFLICT',409);
        // Subscription reactivation does not override an inactive workspace.
        if (tenant.rows[0].lifecycle !== 'active') throw new ManualSubscriptionError("WORKSPACE_NOT_ACTIVE",409);
        const now=await tx.execute(sql`SELECT clock_timestamp() AS now`);
        const liveNow=now.rows[0]?.now as Date | string | null;
        if (!manualReactivationDeadlineLive(before.currentPeriodEnd,liveNow)) throw new ManualSubscriptionError("SUBSCRIPTION_EXPIRED",409);
        const nowMs=parseDbTimeMs(liveNow);
        if (nowMs === null || customerSubscriptionState(
            {...before,status:'active',entitlementBlocked:false},'active',nowMs) !== 'active') {
          throw new ManualSubscriptionError("SUBSCRIPTION_NOT_STARTED",409);
        }
        changes.status='active'; changes.entitlementBlocked=false; changes.entitlementBlockedReason=null;
      }
      if (input.action==='cancel_at_end') {
        if (!before.currentPeriodEnd) throw new ManualSubscriptionError("SUBSCRIPTION_DATES_INVALID");
        changes.cancelAtPeriodEnd=true;
      }
    }
    if (before) await tx.update(tenantSubscriptions).set({...changes, ...(revokedAtSql ? { revokedAt: revokedAtSql } : {}), updatedAt:sql`clock_timestamp()`}).where(eq(tenantSubscriptions.tenantId,tenantId));
    else await tx.insert(tenantSubscriptions).values({tenantId,planId:input.planId!,...changes});
    const after=await tx.query.tenantSubscriptions.findFirst({where:eq(tenantSubscriptions.tenantId,tenantId)});
    const snapshot=publicSnapshot(after!)!;
    if (input.requestId) {
      const approved=await tx.update(subscriptionRequests).set({
        status:'approved',lastActionBy:actor.userId,lastActionAt:approvedAt ?? sql`clock_timestamp()`,
        lastActionReason:input.reason,subscriptionRevision:after!.revision,
        approvedPlanId:input.planId,approvedTerm:input.term,approvedMonthlyQuota:input.monthlyQuota,
        approvalModified:requestApproval?.modified??false,
      }).where(and(eq(subscriptionRequests.id,input.requestId),eq(subscriptionRequests.tenantId,tenantId),eq(subscriptionRequests.status,'pending'))).returning({id:subscriptionRequests.id});
      if (!approved.length || after!.status!=='active') throw new ManualSubscriptionError("SUBSCRIPTION_REQUEST_CONFLICT",409);
    }
    await tx.insert(subscriptionChanges).values({id:`chg_${nanoid(20)}`,tenantId,actorId:actor.userId,action:input.action,idempotencyKey:key,requestDigest:digest,before:publicSnapshot(before??null),after:snapshot,reason:input.reason});
    await writeAuditEvent({tenantId,actorType:'platform',actorId:actor.userId,action:`subscription.${input.action}`,resourceType:'subscription',resourceId:tenantId,metadata:{
      before:publicSnapshot(before??null),after:snapshot,reason:input.reason,
      ...(input.requestId?{requestId:input.requestId,requestedTerms:requestApproval,
        approvedTerms:{planId:input.planId,term:input.term,monthlyQuota:input.monthlyQuota}}:{}),
    }},tx);
    return {subscription:snapshot,replayed:false};
  });
}
