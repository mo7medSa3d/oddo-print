import { assertWorkspaceSecurityOrigin,readWorkspaceSecurityJson } from "../../../../../../lib/workspace-session-http";
import { NextResponse } from "next/server";
import { requirePlatformOwner } from "../../../../../../lib/platform-auth";
import { manualApiError } from "../../../../../../lib/manual-api-error";
import { mutateManualSubscription,parseManualSubscriptionInput,requireIdempotencyKey } from "../../../../../../lib/manual-subscriptions";
export async function POST(req:Request,context:{params:Promise<{id:string}>}) {
  try {
    assertWorkspaceSecurityOrigin(req);
    const actor=await requirePlatformOwner(req),{id}=await context.params;
    const body=await readWorkspaceSecurityJson(req);
    return NextResponse.json(await mutateManualSubscription(id,actor,requireIdempotencyKey(req),parseManualSubscriptionInput(body)),{headers:{"Cache-Control":"private, no-store"}});
  } catch(error) {return manualApiError(error);}
}
