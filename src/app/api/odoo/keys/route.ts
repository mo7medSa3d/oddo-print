import { requireActiveTenantInTransaction } from "../../../../lib/tenant-guard";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../../lib/manager-mutation-authorization";
import { ActionError } from "../../../../lib/action-error";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { apiKeys } from "../../../../db/schema";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { generateOdooApiKey } from "../../../../lib/odoo-auth";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAuditEvent } from "../../../../lib/audit";
import { isTenantBillingError, requireTenantBillingAccess } from "../../../../lib/entitlements";

const keyInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
}).strict();

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const manager = await validateWorkspaceManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Same coded ActionError shape as POST/DELETE so clients parse one
  // authorization-failure contract across the route.
  try { requireManagerPermission(manager, "integrations.read"); } catch { const e = new ActionError("Forbidden", 403, "FORBIDDEN"); return NextResponse.json({ error: e.message, code: e.code, ...(e.details ?? {}) }, { status: e.status }); }
  // Intentionally uncapped: the list page has no pagination and revoked keys
  // remain visible until explicit credential removal; deleted history anchors
  // are deliberately excluded, so
  // a limit would silently hide credentials. The table is low-cardinality and
  // tenant-scoped via api_keys_tenant_id_unique (tenantId, id).
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      description: apiKeys.description,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      readOnlyUntil: apiKeys.readOnlyUntil,
      odooEnabled: apiKeys.odooEnabled,
      odooEnabledRevision: apiKeys.odooEnabledRevision,
      odooEnabledUpdatedAt: apiKeys.odooEnabledUpdatedAt,
      rotationState: sql<"active" | "retiring" | "revoked">`CASE
        WHEN ${apiKeys.revokedAt} IS NOT NULL
          AND ${apiKeys.readOnlyUntil} IS NOT NULL
          AND ${apiKeys.readOnlyUntil} > clock_timestamp()
          THEN 'retiring'
        WHEN ${apiKeys.revokedAt} IS NOT NULL THEN 'revoked'
        ELSE 'active'
      END`,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, manager.tenantId), sql`${apiKeys.hashedKey} NOT LIKE 'deleted:%'`))
    .orderBy(desc(apiKeys.createdAt));

  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const manager = await validateWorkspaceManager(req);
  if (manager) { try { requireManagerPermission(manager, "integrations.manage"); } catch { const e = new ActionError("Forbidden", 403, "FORBIDDEN"); return NextResponse.json({ error: e.message, code: e.code, ...(e.details ?? {}) }, { status: e.status }); } }
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown = {};
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = keyInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid key settings" }, { status: 400 });
  }
  const name = parsed.data.name ?? "Odoo";
  const description = parsed.data.description?.trim() || null;
  const { raw, hashed, id } = generateOdooApiKey();

  try {
    await db.transaction(async (tx) => {
      // Creating a new Odoo credential grants runtime access. Keep the
      // entitlement decision and credential insertion in the SAME transaction
      // so Stripe subscription changes serialize with this control-plane write.
      await requireActiveTenantInTransaction(tx, manager.tenantId);
      await requireManagerActorInTransaction(tx, manager, "integrations.manage");
      await requireTenantBillingAccess(tx, manager.tenantId);

      await tx.insert(apiKeys).values({
      id,
      name,
      description,
      hashedKey: hashed,
      tenantId: manager.tenantId,
    });
    await writeAuditEvent({
      tenantId: manager.tenantId,
      actorType: manager.userId ? "user" : "system",
      actorId: manager.userId ?? "legacy-manager",
      action: "api_key.created",
      resourceType: "api_key",
      resourceId: id,
      metadata: {},
      }, tx);
    });
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (isTenantBillingError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }
  return NextResponse.json({
    id,
    name,
    description,
    apiKey: raw,
    note: "Copy this key now. The raw key will never be shown again.",
  }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request) {
  const manager = await validateWorkspaceManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(manager, "integrations.manage"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  let body: unknown = {};
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { /* invalid body handled below */ }
  const bodyRecord = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const id = typeof bodyRecord.id === "string" ? bodyRecord.id.trim() : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
  if (bodyRecord.remove === true) {
    const removed = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:tenant:${manager.tenantId}`}))`);
      const existing = await tx.select({ id: apiKeys.id }).from(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, manager.tenantId), sql`${apiKeys.hashedKey} NOT LIKE 'deleted:%'`)).for("update");
      if (!existing.length) return null;
      await requireActiveTenantInTransaction(tx, manager.tenantId);
      await requireManagerActorInTransaction(tx, manager, "integrations.manage");
      // Erase the usable credential, retaining only the FK history anchor.
      // Nulling api_key_id would misclassify accepted Odoo jobs as internal
      // and make the addon's reconciliation/status lookups lose those jobs.
      await tx.update(apiKeys).set({ hashedKey: `deleted:${id}`, revokedAt: sql`clock_timestamp()`,
        readOnlyUntil: null, odooEnabled: false, odooEnabledRevision: sql`${apiKeys.odooEnabledRevision} + 1`,
        odooEnabledUpdatedAt: sql`clock_timestamp()` })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, manager.tenantId)));
      await writeAuditEvent({ tenantId: manager.tenantId, actorType: manager.userId ? "user" : "system",
        actorId: manager.userId ?? "legacy-manager", action: "api_key.deleted", resourceType: "api_key", resourceId: id,
        metadata: { credentialErased: true, historyReferenceRetained: true } }, tx);
      return id;
    });
    return removed ? NextResponse.json({ id: removed, removed: true }) : NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  const revoked = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:tenant:${manager.tenantId}`}))`);
    const existing = await tx.select({ id: apiKeys.id }).from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, manager.tenantId), sql`${apiKeys.hashedKey} NOT LIKE 'deleted:%'`)).for("update");
    if (!existing.length) return null;
    await requireActiveTenantInTransaction(tx, manager.tenantId);
    await requireManagerActorInTransaction(tx, manager, "integrations.manage");
    const result = await tx.update(apiKeys)
      .set({ revokedAt: sql`clock_timestamp()`, readOnlyUntil: null, odooEnabled: false, odooEnabledRevision: sql`${apiKeys.odooEnabledRevision} + 1`, odooEnabledUpdatedAt: sql`clock_timestamp()` })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, manager.tenantId), sql`${apiKeys.hashedKey} NOT LIKE 'deleted:%'`))
      .returning({ id: apiKeys.id, revokedAt: apiKeys.revokedAt });
    if (!result.length) return null;
    await writeAuditEvent({
      tenantId: manager.tenantId,
      actorType: manager.userId ? "user" : "system",
      actorId: manager.userId ?? "legacy-manager",
      action: "api_key.revoked",
      resourceType: "api_key",
      resourceId: id,
    }, tx);
    return result[0];
  });
  if (!revoked) return NextResponse.json({ error: "API key not found" }, { status: 404 });
  return NextResponse.json(revoked, { status: 200 });
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
}
