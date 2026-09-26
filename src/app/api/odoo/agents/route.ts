import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { agents } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { isAgentAvailableForJob } from "../../../../lib/agent-availability";
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
    .where(and(eq(agents.lifecycle, "active"), eq(agents.tenantId, apiKey.tenantId)))
    .orderBy(asc(agents.name));

  const now = gatewayNow();
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
