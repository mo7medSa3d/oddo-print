import { NextResponse } from "next/server";
import { db } from "../../../../../../../db";
import { discoverySessions } from "../../../../../../../db/schema";
import { validateWorkspaceManager } from "../../../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../../../lib/authorization";
import { eq, and, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; discoveryId: string }> }) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.disable"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id: agentId, discoveryId } = await params;
  const result = await db.transaction(async (tx) => {
    // Serialize cancellation with the Agent's discovery report. The row lock
    // makes the running-state check and terminal transition one atomic decision.
    const locked = await tx.execute(sql`
      SELECT id, status
      FROM discovery_sessions
      WHERE id = ${discoveryId}
        AND agent_id = ${agentId}
        AND tenant_id = ${claims.tenantId}
      FOR UPDATE
    `);
    const session = locked.rows[0] as { id?: string; status?: string } | undefined;
    if (!session?.id) return { kind: "not_found" as const };
    if (session.status !== "running") return { kind: "already" as const, status: session.status ?? "unknown" };
    await tx.update(discoverySessions)
      .set({ status: "cancelled", completedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(discoverySessions.id, discoveryId), eq(discoverySessions.agentId, agentId), eq(discoverySessions.tenantId, claims.tenantId)));
    return { kind: "cancelled" as const };
  });
  if (result.kind === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (result.kind === "already") return NextResponse.json({ error: `Already ${result.status}` }, { status: 409 });
  return NextResponse.json({ ok: true, status: "cancelled" });
}
