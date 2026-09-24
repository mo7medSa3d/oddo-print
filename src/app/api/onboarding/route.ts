import { NextResponse } from "next/server";
import { db } from "../../../db";
import { plans, tenantSubscriptions, tenants } from "../../../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { validateManager } from "../../../lib/manager-auth";
import { hasManagerPermission } from "../../../lib/authorization";
import { hasBodyOverLimit } from "../../../lib/request-limits";

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasManagerPermission(claims, "billing.read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rows = await db.select({
    id: plans.id, name: plans.name, entitlements: plans.entitlements, currency: plans.currency, interval: plans.interval, stripePriceId: plans.stripePriceId,
  }).from(plans).where(and(eq(plans.isActive, true), eq(plans.isPublic, true)));
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, claims.tenantId), columns: { id: true, name: true } });
  const subscription = await db.query.tenantSubscriptions.findFirst({
    where: eq(tenantSubscriptions.tenantId, claims.tenantId),
    columns: { planId: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
  });
  return NextResponse.json({ tenant, role: claims.role, plans: rows.filter((row) => !!row.stripePriceId).map(({ stripePriceId: _stripePriceId, ...plan }) => plan), subscription });
}

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  const claims = await validateManager(req);
  if (!claims?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasManagerPermission(claims, "tenant.update")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: { workspaceName?: unknown; planId?: unknown; trial?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const name = typeof body.workspaceName === "string" ? body.workspaceName.trim() : "";
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const trial = body.trial === true;
  if (trial && !hasManagerPermission(claims, "billing.manage")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (name.length < 2 || name.length > 120 || !planId) return NextResponse.json({ error: "Workspace name and plan are required" }, { status: 400 });
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, claims.tenantId), columns: { id: true } });
  if (!tenant) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  const plan = await db.query.plans.findFirst({ where: and(eq(plans.id, planId), eq(plans.isActive, true), eq(plans.isPublic, true)), columns: { id: true, stripePriceId: true } });
  if (!plan || !plan.stripePriceId) return NextResponse.json({ error: "Plan not found" }, { status: 400 });

  try {
    await db.transaction(async (tx) => {
    // Serialize onboarding/trial decisions per workspace. Without this lock,
    // two concurrent first-time trial requests can both observe no
    // trialStartedAt before either transaction commits.
    const lockedTenant = await tx.execute(sql`
      SELECT id
      FROM tenants
      WHERE id = ${claims.tenantId}
      FOR UPDATE
    `);
    if (lockedTenant.rows.length !== 1) throw new Error("TENANT_NOT_FOUND");
    await tx.update(tenants).set({ name, updatedAt: sql`now()` }).where(eq(tenants.id, claims.tenantId));
    if (!trial) return;
    // The trial window is compared against the DATABASE clock by every
    // entitlement gate (`current_period_end > clock_timestamp()`), so it must
    // be derived from that same clock. Computing it from the Node host clock
    // let clock drift between Gateway instances silently lengthen or shorten
    // a paying tenant's trial by the drift amount.
    //
    // Both instants are read in ONE statement through `tx` (the transaction's
    // own connection) so that:
    //   1. `trial_started_at` and `current_period_end` come from the exact same
    //      instant — otherwise a long wait on the `FOR UPDATE` tenant lock above
    //      would make the window start before its own start timestamp; and
    //   2. no second connection is pulled from the pool while this transaction
    //      already holds one and is holding the tenant row lock (which would
    //      risk pool-exhaustion deadlock under concurrency).
    const clockRow = await tx.execute(sql`
      SELECT clock_timestamp() AS started_at,
             clock_timestamp() + make_interval(days => 30) AS trial_end
    `);
    const clock = clockRow.rows[0] as { started_at?: Date | string; trial_end?: Date | string } | undefined;
    const startedAt = clock?.started_at ? new Date(clock.started_at) : null;
    const trialEnd = clock?.trial_end ? new Date(clock.trial_end) : null;
    if (!startedAt || !trialEnd || Number.isNaN(startedAt.getTime()) || Number.isNaN(trialEnd.getTime())) {
      throw new Error("DATABASE_CLOCK_UNAVAILABLE");
    }
    const existing = await tx.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, claims.tenantId) });
    if (existing?.trialStartedAt) throw new Error("Trial has already been used for this workspace");
    if (existing) {
      await tx.update(tenantSubscriptions).set({ planId: plan.id, status: "trialing", currentPeriodEnd: trialEnd, trialStartedAt: startedAt, cancelAtPeriodEnd: false, updatedAt: sql`now()` }).where(eq(tenantSubscriptions.tenantId, claims.tenantId));
    } else {
      await tx.insert(tenantSubscriptions).values({ tenantId: claims.tenantId, planId: plan.id, status: "trialing", currentPeriodEnd: trialEnd, trialStartedAt: startedAt });
    }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "TENANT_NOT_FOUND") return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    if (error instanceof Error && error.message === "Trial has already been used for this workspace") return NextResponse.json({ error: "This workspace has already used its trial" }, { status: 409 });
    throw error;
  }
  return NextResponse.json({ ok: true, tenantId: claims.tenantId, next: trial ? "/dashboard" : "/billing" });
}
