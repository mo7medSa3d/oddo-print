import { NextResponse } from "next/server";
import { db } from "../../../db";
import { agents } from "../../../db/schema";
import { validateManager } from "../../../lib/manager-auth";
import { validateConsoleAuth } from "../../../lib/console-auth";
import { requireManagerPermission } from "../../../lib/authorization";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createAgent } from "../../actions";
import { ActionError } from "../../../lib/action-error";
import { logError } from "../../../lib/log";
import { isAgentAvailableForJob } from "../../../lib/agent-availability";

export const dynamic = "force-dynamic";
const createAgentSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();

export async function GET(req: Request) {
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tenantId = auth.kind === "manager" ? auth.claims.tenantId : auth.agent.tenantId;
  if (auth.kind === "manager") {
    try { requireManagerPermission(auth.claims, "agents.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  }
  const where = auth.kind === "agent"
    ? and(eq(agents.tenantId, tenantId), eq(agents.id, auth.agent.id))
    : eq(agents.tenantId, tenantId);
  const rows = await db.select({
    id: agents.id, name: agents.name, status: agents.status, lifecycle: agents.lifecycle,
    metadata: agents.metadata, lastSeenAt: agents.lastSeenAt, createdAt: agents.createdAt,
  }).from(agents).where(where).orderBy(desc(agents.createdAt));
  const now = new Date();
  return NextResponse.json(rows.map((agent) => ({ ...agent, status: isAgentAvailableForJob(agent, now) ? "online" : "offline" })));
}

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (claims) { try { requireManagerPermission(claims, "agents.pair"); } catch { return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } }); } }
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = createAgentSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "agent name is required" }, { status: 400 });
  try {
    return NextResponse.json(await createAgent(parsed.data.name), { status: 201 });
  } catch (error) {
    if (error instanceof ActionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logError("agent.create_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
