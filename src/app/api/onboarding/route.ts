import { NextResponse } from "next/server";
import { db } from "../../../db";
import { plans, tenantSubscriptions, tenants } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { validateManager } from "../../../lib/manager-auth";
import { hasBodyOverLimit } from "../../../lib/request-limits";

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db.select({
    id: plans.id, name: plans.name, entitlements: plans.entitlements, currency: plans.currency, interval: plans.interval, stripePriceId: plans.stripePriceId,
  }).from(plans);
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
  let body: { workspaceName?: unknown; planId?: unknown; trial?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const name = typeof body.workspaceName === "string" ? body.workspaceName.trim() : "";
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const trial = body.trial === true;
  if (name.length < 2 || name.length > 120 || !planId) return NextResponse.json({ error: "Workspace name and plan are required" }, { status: 400 });
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, claims.tenantId), columns: { id: true } });
  if (!tenant) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, planId), columns: { id: true, stripePriceId: true } });
  if (!plan || !plan.stripePriceId) return NextResponse.json({ error: "Plan not found" }, { status: 400 });

  try {
    await db.transaction(async (tx) => {
    await tx.update(tenants).set({ name, updatedAt: new Date() }).where(eq(tenants.id, claims.tenantId));
    if (!trial) return;
    const end = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    const existing = await tx.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, claims.tenantId) });
    if (existing?.trialStartedAt) throw new Error("Trial has already been used for this workspace");
    if (existing) {
      await tx.update(tenantSubscriptions).set({ planId: plan.id, status: "trialing", currentPeriodEnd: end, trialStartedAt: new Date(), cancelAtPeriodEnd: false, updatedAt: new Date() }).where(eq(tenantSubscriptions.tenantId, claims.tenantId));
    } else {
      await tx.insert(tenantSubscriptions).values({ tenantId: claims.tenantId, planId: plan.id, status: "trialing", currentPeriodEnd: end, trialStartedAt: new Date() });
    }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Trial has already been used for this workspace") return NextResponse.json({ error: "This workspace has already used its trial" }, { status: 409 });
    throw error;
  }
  return NextResponse.json({ ok: true, tenantId: claims.tenantId, next: trial ? "/dashboard" : "/billing" });
}
