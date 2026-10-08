import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { agents } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { getAgentHeartbeatFreshness, getEffectiveAgentStatus } from "../../../../lib/agent-availability";
import { gatewayNow, refreshClockSkew } from "../../../../lib/database-clock";
import { TenantSubscriptionRequiredError, requireTenantBillingAccess } from "../../../../lib/entitlements";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const apiKey = await validateOdooKey(req, { requireIntegrationEnabled: false });
  if (!apiKey) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Agent discovery is part of the runtime control plane and must use the
  // exact same database-authoritative billing predicate as pairing, printing,
  // and resource admission. This intentionally keeps past_due tenants usable
  // during Stripe recovery even after the nominal period end.
  try {
    await requireTenantBillingAccess(db, apiKey.tenantId);
  } catch (error) {
    if (error instanceof TenantSubscriptionRequiredError) {
      return NextResponse.json(
        { error: error.message, code: "SUBSCRIPTION_REQUIRED" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }

  const params = new URL(req.url).searchParams;
  const agentId = params.get("agent_id")?.trim();
  const agentName = params.get("name")?.trim();
  const limitValue = params.get("limit") ?? "200";
  const offsetValue = params.get("offset") ?? "0";
  const limit = Number(limitValue);
  const offset = Number(offsetValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) {
    return NextResponse.json({ error: "limit must be 1-200 and offset must be 0-10000" }, { status: 400 });
  }
  const conditions = [eq(agents.lifecycle, "active"), eq(agents.tenantId, apiKey.tenantId)];
  if (agentId) conditions.push(eq(agents.id, agentId));
  if (agentName) conditions.push(eq(agents.name, agentName));

  // Agent heartbeat timestamps are still rendered using the calibrated Gateway
  // clock because availability is a host-side presentation calculation.
  await refreshClockSkew();

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      lifecycle: agents.lifecycle,
      lastSeenAt: agents.lastSeenAt,
    })
    .from(agents)
    .where(and(...conditions))
    .orderBy(asc(agents.name), asc(agents.id))
    .limit(limit + 1)
    .offset(offset);

  const now = gatewayNow();
  const hasMore = rows.length > limit;
  const sanitized = rows.slice(0, limit).map((agent) => ({
    id: agent.id,
    name: agent.name,
    // Current presentation state is evidence-based: stale/missing heartbeat
    // becomes unknown, while the last Agent-reported value remains available
    // separately for diagnostics.
    status: getEffectiveAgentStatus(agent, now),
    reportedStatus: agent.status,
    freshness: getAgentHeartbeatFreshness(agent.lastSeenAt, now),
    lifecycle: agent.lifecycle,
    lastSeenAt: agent.lastSeenAt,
  }));

  return NextResponse.json({
    agents: sanitized,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  }, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
