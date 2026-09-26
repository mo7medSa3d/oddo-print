import { NextResponse } from "next/server";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { getAllAgentsHealth, getAgentHealth } from "../../../../lib/agent-health";
import { requestIdFrom } from "../../../../lib/log";
import { runWithCorrelation, generateRequestId } from "../../../../server/correlation";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const requestId = requestIdFrom(req as any) || generateRequestId();
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");

  return runWithCorrelation({ requestId, tenantId: claims.tenantId, agentId: agentId ?? undefined } as any, async () => {
    if (agentId) {
      const health = await getAgentHealth(claims.tenantId, agentId);
      if (!health) return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "x-request-id": requestId } });
      return NextResponse.json(health, { headers: { "x-request-id": requestId } });
    }
    const all = await getAllAgentsHealth(claims.tenantId);
    return NextResponse.json(all, { headers: { "x-request-id": requestId } });
  });
}
