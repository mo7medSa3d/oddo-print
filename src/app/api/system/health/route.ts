import { NextResponse } from "next/server";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { getSystemHealth } from "../../../../lib/system-health";
import { requestIdFrom } from "../../../../lib/log";
import { runWithCorrelation, generateRequestId } from "../../../../server/correlation";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const requestId = requestIdFrom(req as any) || generateRequestId();
  return runWithCorrelation({ requestId, tenantId: claims.tenantId } as any, async () => {
    const health = await getSystemHealth(claims.tenantId);
    return NextResponse.json(health, { headers: { "x-request-id": requestId } });
  });
}
