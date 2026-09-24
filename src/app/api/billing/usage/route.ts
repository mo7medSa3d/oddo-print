import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { agents, printers, plans, tenantSubscriptions } from "../../../../db/schema";
import { getTenantEntitlements, getTenantPrintUsage, isTenantBillingError } from "../../../../lib/entitlements";
import { validateManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(manager, "billing.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  try {
    const subscription = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, manager.tenantId),
      columns: { planId: true },
    });
    if (!subscription) return NextResponse.json({ error: "An active subscription is required", code: "TENANT_SUBSCRIPTION_REQUIRED" }, { status: 403 });

    const plan = await db.query.plans.findFirst({
      where: eq(plans.id, subscription.planId),
      columns: { id: true, name: true, entitlements: true },
    });
    if (!plan) return NextResponse.json({ error: "Plan configuration is unavailable", code: "TENANT_ENTITLEMENT_UNAVAILABLE" }, { status: 403 });

    const entitlements = await getTenantEntitlements(db, manager.tenantId);
    const printUsage = await getTenantPrintUsage(db, manager.tenantId);
    const counts = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM agents WHERE tenant_id = ${manager.tenantId} AND lifecycle <> 'retired') AS "agents",
        (SELECT COUNT(*)::int FROM printers WHERE tenant_id = ${manager.tenantId} AND lifecycle <> 'retired') AS "printers"
    `);
    const row = counts.rows[0] as { agents?: number | string; printers?: number | string } | undefined;

    return NextResponse.json({
      plan: { id: plan.id, name: plan.name },
      resources: {
        agents: { used: Number(row?.agents ?? 0), limit: entitlements.max_agents },
        printers: { used: Number(row?.printers ?? 0), limit: entitlements.max_printers },
        prints: {
          unit: "job",
          used: printUsage.used,
          limit: printUsage.limit,
          remaining: printUsage.remaining,
          periodStart: printUsage.periodStart.toISOString(),
          periodEnd: printUsage.periodEnd?.toISOString() ?? null,
        },
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isTenantBillingError(error)) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
    }
    return NextResponse.json({ error: "Usage information is temporarily unavailable", code: "USAGE_UNAVAILABLE" }, { status: 503 });
  }
}
