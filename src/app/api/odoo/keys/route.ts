import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { apiKeys } from "../../../../db/schema";
import { validateManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { generateOdooApiKey } from "../../../../lib/odoo-auth";
import { eq, and, desc, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAuditEvent } from "../../../../lib/audit";
import { isTenantBillingError, requireTenantBillingAccess } from "../../../../lib/entitlements";

const keyInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
}).strict();

export const dynamic = "force-dynamic";

// Drizzle wraps driver errors (DrizzleQueryError -> cause -> pg error), so
// the SQLSTATE code must be unwrapped before matching.
function pgErrorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export async function GET(req: Request) {
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(manager, "integrations.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  // Intentionally uncapped: the list page has no pagination and revoked keys
  // must remain visible (they cannot be removed while referenced by jobs), so
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
    .where(eq(apiKeys.tenantId, manager.tenantId))
    .orderBy(desc(apiKeys.createdAt));

  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const manager = await validateManager(req);
  if (manager) { try { requireManagerPermission(manager, "integrations.manage"); } catch { return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } }); } }
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
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
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(manager, "integrations.manage"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  let body: unknown = {};
  try { body = await req.json(); } catch { /* invalid body handled below */ }
  const bodyRecord = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const id = typeof bodyRecord.id === "string" ? bodyRecord.id.trim() : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  // Permanent removal is only allowed for already-revoked keys: deleting an
  // active credential would silently break Odoo and destroy attribution for
  // jobs stamped with this key. Keys referenced by print jobs are protected
  // by the print_jobs foreign key and cannot be removed (history preserved).
  if (bodyRecord.remove === true) {
    try {
      const removed = await db.delete(apiKeys)
        .where(and(
          eq(apiKeys.id, id),
          eq(apiKeys.tenantId, manager.tenantId),
          isNotNull(apiKeys.revokedAt),
          or(
            isNull(apiKeys.readOnlyUntil),
            lte(apiKeys.readOnlyUntil, sql`clock_timestamp()`),
          ),
        ))
        .returning({ id: apiKeys.id });
      if (removed.length) return NextResponse.json({ id: removed[0].id, removed: true }, { status: 200 });
    } catch (error) {
      if (pgErrorCode(error) === "23503") {
        return NextResponse.json({ error: "API key has associated print jobs and cannot be removed." }, { status: 409 });
      }
      throw error;
    }
    const existing = await db.query.apiKeys.findFirst({ where: and(eq(apiKeys.id, id), eq(apiKeys.tenantId, manager.tenantId)) });
    if (!existing) return NextResponse.json({ error: "API key not found" }, { status: 404 });
    return NextResponse.json({ error: "Only revoked API keys can be removed. Revoke the key first." }, { status: 409 });
  }

  const revoked = await db.transaction(async (tx) => {
    const result = await tx.update(apiKeys)
      .set({ revokedAt: sql`clock_timestamp()`, odooEnabled: false })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, manager.tenantId)))
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
}
