import { NextResponse } from "next/server";
import { validateManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { requestIdFrom } from "../../../../lib/log";
import { runWithCorrelation, generateRequestId } from "../../../../server/correlation";

export const dynamic = "force-dynamic";

/**
 * Windows Service Recovery status — enterprise requirement
 * In real Windows deployment, this would query SCM via Go agent heartbeat metadata
 * or via Tauri command. In sandbox, returns BLOCKED with explanation.
 */

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const requestId = requestIdFrom(req as any) || generateRequestId();
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");

  return runWithCorrelation({ requestId, tenantId: claims.tenantId, agentId: agentId ?? undefined } as any, async () => {
    // In production Windows, this data comes from agent metadata (service state) and SCM query
    // For now, return structure with BLOCKED note for sandbox
    const mockStatus = {
      agentId: agentId ?? "unknown",
      serviceName: "YasserPrintAgent",
      displayName: "Yasser Print Agent",
      state: "UNKNOWN" as const,
      startType: "AUTOMATIC" as const,
      recovery: {
        firstFailure: "restart/5000",
        secondFailure: "restart/10000",
        subsequentFailure: "restart/30000",
        resetPeriodSec: 86400,
        failureFlag: true,
      },
      lastRestart: null,
      failureCount: 0,
      exitCode: 0,
      uptimeSeconds: null,
      blocked: true,
      blockedReason: "BLOCKED: Windows Service Control Manager query requires Windows host with sc.exe and service installed. In sandbox, code is hardened (system32_exe validation, run_bounded_command budget, background PID meta creation_time+image) but runtime not proven. See docs/WINDOWS_SERVICE_RECOVERY.md for kill→restart→reconnect test procedure.",
      instructions: "On Windows: sc query YasserPrintAgent, sc qfailure YasserPrintAgent, taskkill /F /PID <pid>, wait 10s, sc query, verify Gateway /api/agents/health shows ONLINE again.",
      correlation: { requestId, tenantId: claims.tenantId, agentId },
    };

    return NextResponse.json(mockStatus, { headers: { "x-request-id": requestId } });
  });
}
