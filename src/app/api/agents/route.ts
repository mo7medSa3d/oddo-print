import { NextResponse } from "next/server";
import { db } from "../../../db";
import { agents } from "../../../db/schema";
import { validateWorkspaceManager } from "../../../lib/manager-auth";
import { validateConsoleAuth } from "../../../lib/console-auth";
import { requireManagerPermission } from "../../../lib/authorization";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { clampListLimit } from "../../../lib/request-limits";
import { z } from "zod";
import { createAgentForManager } from "../../../lib/agent-control";
import { ActionError } from "../../../lib/action-error";
import { logError } from "../../../lib/log";
import { agentStaleThresholdSeconds, getAgentHeartbeatFreshness, getEffectiveAgentStatus } from "../../../lib/agent-availability";
import { gatewayNow, refreshClockSkew } from "../../../lib/database-clock";

export const dynamic = "force-dynamic";
const createAgentSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
const MAX_AGENTS_LIST = 1000;
const MAX_AGENTS_OFFSET = 10_000;

export async function GET(req: Request) {
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tenantId = auth.kind === "manager" ? auth.claims.tenantId : auth.agent.tenantId;
  if (auth.kind === "manager") {
    try { requireManagerPermission(auth.claims, "agents.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  }
  // Per-request transport bound, not a product cardinality cap. Plans may
  // explicitly allow unlimited Agents; callers must paginate rather than infer a fleet limit.
  const { searchParams } = new URL(req.url);
  const limit = clampListLimit(searchParams.get("limit"), 1000, MAX_AGENTS_LIST);
  const offsetRaw = parseInt(searchParams.get("offset") ?? "0", 10);
  const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);
  if (offset > MAX_AGENTS_OFFSET) {
    return NextResponse.json({ error: `offset must be <= ${MAX_AGENTS_OFFSET}; use beforeCreatedAt + beforeId keyset pagination for deeper fleets` }, { status: 400 });
  }
  const beforeCreatedAtRaw = searchParams.get("beforeCreatedAt");
  const beforeId = searchParams.get("beforeId");
  if ((beforeCreatedAtRaw == null) !== (beforeId == null)) {
    return NextResponse.json({ error: "beforeCreatedAt and beforeId must be provided together" }, { status: 400 });
  }
  if (beforeId != null && (beforeId.length < 1 || beforeId.length > 512)) {
    return NextResponse.json({ error: "beforeId must be between 1 and 512 characters" }, { status: 400 });
  }
  const beforeCreatedAt = beforeCreatedAtRaw == null ? null : new Date(beforeCreatedAtRaw);
  if (beforeCreatedAt && Number.isNaN(beforeCreatedAt.getTime())) {
    return NextResponse.json({ error: "beforeCreatedAt must be a valid timestamp" }, { status: 400 });
  }
  if (beforeCreatedAt && offset !== 0) {
    return NextResponse.json({ error: "offset cannot be combined with keyset pagination" }, { status: 400 });
  }
  const ownershipWhere = auth.kind === "agent"
    ? and(eq(agents.tenantId, tenantId), eq(agents.id, auth.agent.id))
    : eq(agents.tenantId, tenantId);
  const cursorWhere = beforeCreatedAt && beforeId
    ? or(lt(agents.createdAt, beforeCreatedAt), and(eq(agents.createdAt, beforeCreatedAt), lt(agents.id, beforeId)))
    : undefined;
  const where = cursorWhere ? and(ownershipWhere, cursorWhere) : ownershipWhere;
  await refreshClockSkew();
  const now = gatewayNow();
  const rows = await db.select({
    id: agents.id, name: agents.name, status: agents.status, lifecycle: agents.lifecycle,
    metadata: agents.metadata, lastSeenAt: agents.lastSeenAt, createdAt: agents.createdAt,
  }).from(agents).where(where).orderBy(desc(agents.createdAt), desc(agents.id)).limit(limit + 1).offset(beforeCreatedAt ? 0 : offset);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const staleThresholdSeconds = agentStaleThresholdSeconds();
  const responseRows = pageRows.map((agent) => ({
    ...agent,
    reportedStatus: agent.status,
    freshness: getAgentHeartbeatFreshness(agent.lastSeenAt, now),
    status: getEffectiveAgentStatus(agent, now),
    staleThresholdSeconds,
  }));
  const last = pageRows[pageRows.length - 1];
  return NextResponse.json(responseRows, {
    headers: {
      "Cache-Control": "no-store",
      "X-Has-More": hasMore ? "true" : "false",
      ...(hasMore && last ? {
        "X-Next-Before-Created-At": last.createdAt.toISOString(),
        "X-Next-Before-Id": last.id,
      } : {}),
    },
  });
}

export async function POST(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.pair"); } catch { const e = new ActionError("Forbidden", 403, "FORBIDDEN"); return NextResponse.json({ error: e.message, code: e.code, ...(e.details ?? {}) }, { status: e.status }); }
  let body: unknown;
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = createAgentSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "agent name is required" }, { status: 400 });
  try {
    return NextResponse.json(await createAgentForManager(parsed.data.name, claims), { status: 201 });
  } catch (error) {
    if (error instanceof ActionError) {
      return NextResponse.json({ error: error.message, code: error.code ?? "ACTION_ERROR", ...(error.details ?? {}) }, { status: error.status });
    }
    logError("agent.create_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
