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
    const rawLimit = url.searchParams.get("limit");
    const rawOffset = url.searchParams.get("offset");
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
      return NextResponse.json(
        { error: "Invalid pagination", code: "INVALID_PAGINATION" },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const page = await getAllAgentsHealth(claims.tenantId, limit + 1, offset);
    const hasMore = page.length > limit;
    const all = hasMore ? page.slice(0, limit) : page;
    return NextResponse.json(all, { headers: {
      "x-request-id": requestId,
      "x-page-limit": String(limit),
      "x-page-offset": String(offset),
      "x-has-more": String(hasMore),
      ...(hasMore ? { "x-next-offset": String(offset + limit) } : {}),
    } });
  });
}
