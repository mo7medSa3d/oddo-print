import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { printers, agents } from "../../../../../db/schema";
import { validateConsoleAuth } from "../../../../../lib/console-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { and, eq } from "drizzle-orm";
import { getAgentAvailability, isPrinterObservationFresh } from "../../../../../lib/agent-availability";

export const dynamic = "force-dynamic";

// Diagnostic endpoint. This build intentionally reports cached heartbeat state,
// not a live LAN probe. `live: false` is part of the response contract so UIs
// cannot present cached reachability as a just-tested TCP result.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.kind === "manager") {
    try { requireManagerPermission(auth.claims, "printers.test"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  }

  const tenantId = auth.kind === "manager" ? auth.claims.tenantId : auth.agent.tenantId;
  const { id } = await params;
  const printer = await db.query.printers.findFirst({
    where: auth.kind === "agent"
      ? and(eq(printers.id, id), eq(printers.tenantId, tenantId), eq(printers.agentId, auth.agent.id))
      : and(eq(printers.id, id), eq(printers.tenantId, tenantId)),
  });
  if (!printer) return NextResponse.json({ error: "Printer not found" }, { status: 404 });

  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, printer.agentId), eq(agents.tenantId, tenantId)) });
  if (!agent) return NextResponse.json({
    reachable: false,
    latencyMs: null,
    live: false,
    lastHeartbeatAt: null,
    agentOnline: false,
    agentAvailabilityReason: "agent_not_found",
    error: "agent not found",
  }, { status: 404 });

  const availability = getAgentAvailability(agent);
  const agentState = {
    lastHeartbeatAt: agent.lastSeenAt,
    agentOnline: availability.available,
    agentAvailabilityReason: availability.reason,
  };

  if (printer.lifecycle !== "active") {
    return NextResponse.json({
      reachable: false,
      latencyMs: null,
      live: false,
      ...agentState,
      error: "printer disabled",
    });
  }

  const cfg = (printer.config ?? {}) as Record<string, unknown>;
  if (printer.connectionType === "network" && (!cfg.ip || !cfg.port)) {
    return NextResponse.json({
      reachable: false,
      latencyMs: null,
      live: false,
      ...agentState,
      error: "missing ip/port in config",
    });
  }

  if (!availability.available) {
    return NextResponse.json({
      reachable: false,
      latencyMs: null,
      live: false,
      ...agentState,
      error: `agent unavailable (${availability.reason}) — printer reachability unknown until agent availability is restored`,
    });
  }

  const printerFresh = isPrinterObservationFresh(printer.lastSeenAt);
  const reachable = (printer.status === "online" || printer.status === "busy") && availability.available && printerFresh;
  return NextResponse.json({
    reachable,
    latencyMs: null,
    live: false,
    ...agentState,
    printerLastSeenAt: printer.lastSeenAt,
    printerObservationFresh: printerFresh,
    error: reachable ? null : !printerFresh ? "printer observation is stale or missing" : `last heartbeat printer.status=${printer.status}`,
  });
}
