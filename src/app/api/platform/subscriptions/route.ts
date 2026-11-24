import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "../../../../db";
import { requirePlatformOwner, requirePlatformReadAuthorityInTransaction } from "../../../../lib/platform-auth";
import { manualApiError } from "../../../../lib/manual-api-error";
import { effectiveSubscriptionStatusSql } from "../../../../lib/effective-subscription-status";
import { parseStrictListLimit, parseStrictListOffset } from "../../../../lib/request-limits";
const HEADERS = { "Cache-Control": "private, no-store" };
export async function GET(req:Request) {
 try {
  const actor=await requirePlatformOwner(req);const params=new URL(req.url).searchParams;
  const limit=parseStrictListLimit(params.get("limit"),300,300);
  const offset=parseStrictListOffset(params.get("offset"),1_000_000);
  if(limit===null||offset===null)return NextResponse.json({error:"Invalid pagination",code:"INVALID_PAGINATION"},{status:400,headers:HEADERS});
  const status=params.get("status")??"all";
  if(!["all","active","awaiting_activation","expired","suspended"].includes(status))return NextResponse.json({error:"Invalid subscription filter",code:"INVALID_FILTER"},{status:400,headers:HEADERS});
  const search=(params.get('search')??'').trim(),term=`%${search.replace(/[%_\\]/g,'\\$&')}%`;
  if(search.length>200)return NextResponse.json({error:"Search too long",code:"INVALID_SEARCH"},{status:400,headers:HEADERS});
  const statusSql=effectiveSubscriptionStatusSql({tenantId:sql`t.id`,tenantLifecycle:sql`t.lifecycle`,subscriptionStatus:sql`s.status`,entitlementBlocked:sql`s.entitlement_blocked`,currentPeriodStart:sql`s.current_period_start`});
  const rows=await db.transaction(async tx=>{
    await requirePlatformReadAuthorityInTransaction(tx,actor);
    return tx.execute(sql`SELECT t.id AS "tenantId",t.name AS "tenantName",t.lifecycle AS "tenantLifecycle",p.name AS "planName",s.plan_id AS "planId",${statusSql} AS status,s.subscription_type AS "subscriptionType",coalesce(s.monthly_quota,CASE WHEN p.entitlements->>'max_prints_per_period' ~ '^[0-9]{1,10}$' THEN CASE WHEN (p.entitlements->>'max_prints_per_period')::numeric BETWEEN 1 AND 2147483647 THEN (p.entitlements->>'max_prints_per_period')::int END ELSE NULL END) AS "monthlyQuota",s.current_period_end AS "currentPeriodEnd",s.term,s.cancel_at_period_end AS "cancelAtPeriodEnd",0::int AS used FROM tenant_subscriptions s JOIN tenants t ON t.id=s.tenant_id JOIN plans p ON p.id=s.plan_id WHERE (t.name ILIKE ${term} OR t.id ILIKE ${term}) AND (${status} = 'all' OR ${statusSql} = ${status}) ORDER BY t.created_at DESC,t.id DESC LIMIT ${limit + 1} OFFSET ${offset}`);
  });
  return NextResponse.json({subscriptions:rows.rows.slice(0,limit),hasMore:rows.rows.length>limit,limit,offset},{headers:HEADERS});
 }catch(e){const response=manualApiError(e);response.headers.set("Cache-Control","private, no-store");return response;}
}
