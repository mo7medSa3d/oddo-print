import { TenantLifecycleError } from "./tenant-lifecycle";
import { TenantSuspendedError, TenantDeletedError } from "./tenant-guard";
import { WorkspaceSecurityRequestError } from "./workspace-session-http";
import { NextResponse } from "next/server";
import { ManualSubscriptionError } from "./manual-subscriptions";
import { PlatformUnauthorizedError, PlatformMutationAuthorityChangedError } from "./platform-auth";
import { ManagerMutationAuthorityChangedError } from "./manager-mutation-authorization";
import { logError } from "./log";
export function manualApiError(error: unknown): Response {
  // The caller may expose confidential workspace or Platform details.
  // Every error (including a live owner revocation) must be uncacheable.
  let response: Response;
  if (error instanceof TenantSuspendedError || error instanceof TenantDeletedError) {
    response = NextResponse.json({error:error.message,code:error.code},{status:error.status});
  } else if (error instanceof TenantLifecycleError) {
    response = NextResponse.json({error:error.code,code:error.code},{status:error.status});
  } else if (error instanceof WorkspaceSecurityRequestError) {
    response = NextResponse.json({error:error.code,code:error.code},{status:error.status});
  } else if (error instanceof ManualSubscriptionError) {
    response = NextResponse.json({error:error.code,code:error.code},{status:error.status});
  } else if (error instanceof PlatformUnauthorizedError) {
    response = NextResponse.json({error:"Unauthorized",code:"UNAUTHORIZED"},{status:401});
  } else if (error instanceof PlatformMutationAuthorityChangedError) {
    response = NextResponse.json({error:"Your platform authorization changed. Sign in again.",code:"PLATFORM_AUTHORITY_CHANGED"},{status:403});
  } else if (error instanceof ManagerMutationAuthorityChangedError) {
    response = error.response();
  } else {
    logError("manual_api.unexpected_error", { error });
    response = NextResponse.json({error:"Service unavailable",code:"MANUAL_SUBSCRIPTION_UNAVAILABLE"},{status:503});
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
