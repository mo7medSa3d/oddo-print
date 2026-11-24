import { db } from "../../../../db";
import { requireActiveTenantInTransaction } from "../../../../lib/tenant-guard";
import { requireManagerActorInTransaction } from "../../../../lib/manager-mutation-authorization";
import { requireWorkspaceSessionInTransaction } from "../../../../lib/workspace-session-security";
import { assertWorkspaceSecurityOrigin, requireWorkspaceSecurityClaims, workspaceSecurityErrorResponse, WORKSPACE_SECURITY_HEADERS } from "../../../../lib/workspace-session-http";

export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  try {
    assertWorkspaceSecurityOrigin(req);
    const claims = await requireWorkspaceSecurityClaims(req);
    await db.transaction(async tx => {
      await requireActiveTenantInTransaction(tx, claims.tenantId);
      await requireManagerActorInTransaction(tx, claims, "tenant.read");
      await requireWorkspaceSessionInTransaction(tx, claims, { touch: true });
    });
    return new Response(null, { status: 204, headers: WORKSPACE_SECURITY_HEADERS });
  } catch (error) { return workspaceSecurityErrorResponse(error); }
}
