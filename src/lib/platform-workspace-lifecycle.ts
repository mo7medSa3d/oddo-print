import { NextResponse } from "next/server";
import { requirePlatformOwner } from "./platform-auth";
import { assertWorkspaceSecurityOrigin,readWorkspaceSecurityJson } from "./workspace-session-http";
import { transitionTenantLifecycle } from "./tenant-lifecycle";
import { ManualSubscriptionError,requireIdempotencyKey } from "./manual-subscriptions";
import { manualApiError } from "./manual-api-error";
export async function platformWorkspaceLifecycle(req:Request,id:string,next:'active'|'suspended'){
 try{
  assertWorkspaceSecurityOrigin(req);const claims=await requirePlatformOwner(req),key=requireIdempotencyKey(req);
  const b=await readWorkspaceSecurityJson(req) as Record<string,unknown>;
  if(!b||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>500||!['active','suspended'].includes(String(b.expectedLifecycle))||typeof b.expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(b.expectedUpdatedAt)))throw new ManualSubscriptionError('SUBSCRIPTION_INVALID');
  const result=await transitionTenantLifecycle(id,next,b.reason,{type:'platform',id:claims.userId,claims,idempotencyKey:key,expectedLifecycle:b.expectedLifecycle as 'active'|'suspended',expectedUpdatedAt:b.expectedUpdatedAt});
  return NextResponse.json({ok:true,tenantId:id,...result},{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){return manualApiError(error);}
}
