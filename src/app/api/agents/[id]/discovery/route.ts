import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { agents, discoverySessions } from "../../../../../db/schema";
import { validateWorkspaceManager } from "../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "../../../../../lib/nanoid";
import { validateDiscoveryRequest } from "../../../../../lib/discovery";

export const dynamic = "force-dynamic";

// Discovery is runtime infrastructure only. It never receives or creates Odoo business ownership.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.pair"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id: agentId } = await params;
  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, agentId), eq(agents.tenantId, claims.tenantId)) });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const v = validateDiscoveryRequest(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const discoveryId = `dsc_${nanoid(12)}`;
  try {
    await db.transaction(async (tx) => {
      // Serialize discovery starts per agent. The database unique partial
      // index remains the final invariant for every writer.
      const locked = await tx.execute(sql`
        SELECT id, lifecycle
        FROM agents
        WHERE id = ${agentId} AND tenant_id = ${claims.tenantId}
        FOR UPDATE
      `);
      const lockedAgent = locked.rows[0] as { id?: string; lifecycle?: string } | undefined;
      if (!lockedAgent?.id) throw new Error("AGENT_NOT_FOUND");
      if (lockedAgent.lifecycle !== "active") throw new Error("AGENT_NOT_ACTIVE");

      const active = await tx.query.discoverySessions.findFirst({
        where: and(
          eq(discoverySessions.agentId, agentId),
          eq(discoverySessions.tenantId, claims.tenantId),
          eq(discoverySessions.status, "running"),
        ),
      });
      if (active) throw new Error("DISCOVERY_ALREADY_RUNNING");

      await tx.insert(discoverySessions).values({
        id: discoveryId,
        tenantId: claims.tenantId,
        agentId,
        status: "running",
        config: v.data,
        stats: {},
        startedAt: sql`now()`,
      });
      // Push discovery instantly via Postgres NOTIFY -> WebSocket (10-50ms)
      // instead of waiting for agent's 10s poll fallback. Matches job delivery path.
      await tx.execute(sql`SELECT pg_notify('print_gateway_discovery', ${JSON.stringify({ agentId, discoveryId })}::text)`);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AGENT_NOT_FOUND") {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    if (error instanceof Error && error.message === "AGENT_NOT_ACTIVE") {
      return NextResponse.json({ error: "Agent is not active" }, { status: 409 });
    }
    if (error instanceof Error && error.message === "DISCOVERY_ALREADY_RUNNING") {
      return NextResponse.json({ error: "Discovery already running for this agent" }, { status: 409 });
    }
    if ((error as { code?: string })?.code === "23505") {
      return NextResponse.json({ error: "Discovery already running for this agent" }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({ discoveryId, agentId, status: "running" }, { status: 201 });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id: agentId } = await params;
  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, agentId), eq(agents.tenantId, claims.tenantId)) });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const rows = await db.query.discoverySessions.findMany({ where: and(eq(discoverySessions.agentId, agentId), eq(discoverySessions.tenantId, claims.tenantId)), orderBy: [desc(discoverySessions.createdAt)], limit: 20 });
  return NextResponse.json(rows);
}