import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { agents, tenantSubscriptions } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { isAgentAvailableForJob } from "../../../../lib/agent-availability";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const apiKey = await validateOdooKey(req);
  if (!apiKey) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Pairing an agent requires an active plan subscription.
  const sub = await db.query.tenantSubscriptions.findFirst({
    where: eq(tenantSubscriptions.tenantId, apiKey.tenantId),
    columns: { status: true, currentPeriodEnd: true },
  });
  const periodLive = !sub?.currentPeriodEnd || new Date(sub.currentPeriodEnd) > new Date();
  if (!sub || !["trialing", "active", "past_due"].includes(sub.status) || !periodLive) {
    return NextResponse.json(
      { error: "An active subscription is required before pairing agents.", code: "SUBSCRIPTION_REQUIRED" },
      { status: 403 },
    );
  }

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      lifecycle: agents.lifecycle,
      lastSeenAt: agents.lastSeenAt,
    })
    .from(agents)
    .where(and(eq(agents.lifecycle, "active"), eq(agents.tenantId, apiKey.tenantId)))
    .orderBy(asc(agents.name));

  const now = new Date();
  const sanitized = rows.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: isAgentAvailableForJob(agent, now) ? "online" : "offline",
    lifecycle: agent.lifecycle,
    lastSeenAt: agent.lastSeenAt,
  }));

  return NextResponse.json({ agents: sanitized }, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
