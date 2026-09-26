import { ActionError } from "../../../../lib/action-error";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { agents, printers, printJobs } from "../../../../db/schema";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { eq, count, desc, and } from "drizzle-orm";
import { z } from "zod";
import { transitionAgentLifecycle, LifecycleConflict } from "../../../../lib/agent-lifecycle";
import { logError } from "../../../../lib/log";
import { getEffectivePrinterStatus, isAgentAvailableForJob } from "../../../../lib/agent-availability";
import { gatewayNow, refreshClockSkew } from "../../../../lib/database-clock";
import { isTenantBillingError } from "../../../../lib/entitlements";

export const dynamic = "force-dynamic";
const patchSchema = z.object({ lifecycle: z.enum(["active", "disabled", "retired"]) }).strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id } = await params;
  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, id), eq(agents.tenantId, claims.tenantId)) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const agentPrinters = await db.query.printers.findMany({ where: and(eq(printers.agentId, id), eq(printers.tenantId, claims.tenantId)), orderBy: [desc(printers.createdAt)] });
  const [jobs] = await db.select({ c: count() }).from(printJobs).where(and(eq(printJobs.agentId, id), eq(printJobs.tenantId, claims.tenantId)));
  const { secret: _secret, pairingCodeHash: _pch, pairingCode: _pc, pairingCodeExpiresAt: _exp, ...safe } = agent as Record<string, unknown>;
  await refreshClockSkew();
  const now = gatewayNow();
  const safeAgent = { ...safe, status: isAgentAvailableForJob(agent, now) ? "online" : "offline" };
  const effectivePrinters = agentPrinters.map((printer) => ({ ...printer, status: getEffectivePrinterStatus(printer, agent, now) }));
  return NextResponse.json({ agent: safeAgent, printers: effectivePrinters, jobCount: jobs?.c ?? 0 });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateWorkspaceManager(req);
  if (claims) { try { requireManagerPermission(claims, "agents.disable"); } catch { const e = new ActionError("Forbidden", 403, "FORBIDDEN"); return NextResponse.json({ error: e.message, code: e.code, ...(e.details ?? {}) }, { status: e.status }); } }
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let body: unknown; try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "lifecycle is required" }, { status: 400 });
  const { lifecycle } = parsed.data;
  try {
    const result = await transitionAgentLifecycle(id, lifecycle, claims.tenantId, { type: "user", id: claims.userId ?? null });
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, lifecycle: result.lifecycle, pairingCode: result.pairingCode });
  } catch (error) {
    if (error instanceof LifecycleConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (isTenantBillingError(error)) return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
    logError("agent.lifecycle_failed", { agentId: id, error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}