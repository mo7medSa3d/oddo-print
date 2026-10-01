import { logError } from "../../../../../../lib/log";
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../../../../db";
import { apiKeys } from "../../../../../../db/schema";
import { validateWorkspaceManager } from "../../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../../lib/authorization";
import { generateOdooApiKey } from "../../../../../../lib/odoo-auth";
import { writeAuditEvent } from "../../../../../../lib/audit";

export const dynamic = "force-dynamic";

const ODOO_KEY_ROTATION_GRACE_MS = 60 * 60 * 1000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const manager = await validateWorkspaceManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    requireManagerPermission(manager, "integrations.manage");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!id?.trim()) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    const rotated = await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id, name, description, revoked_at,
               odoo_enabled, odoo_enabled_revision, odoo_enabled_updated_at
        FROM api_keys
        WHERE id = ${id} AND tenant_id = ${manager.tenantId}
        FOR UPDATE
      `);
      const old = locked.rows[0] as {
        id: string;
        name: string;
        description: string | null;
        revoked_at: Date | string | null;
        odoo_enabled: boolean;
        odoo_enabled_revision: number | string;
        odoo_enabled_updated_at: Date | string | null;
      } | undefined;
      if (!old) return { kind: "not_found" as const };
      if (old.revoked_at) return { kind: "revoked" as const };

      const { raw, hashed, id: newId } = generateOdooApiKey();
      await tx.insert(apiKeys).values({
        id: newId,
        tenantId: manager.tenantId,
        name: old.name,
        description: old.description,
        hashedKey: hashed,
        odooEnabled: old.odoo_enabled === true,
        odooEnabledRevision: Number(old.odoo_enabled_revision ?? -1),
        odooEnabledUpdatedAt: old.odoo_enabled_updated_at ? new Date(old.odoo_enabled_updated_at) : null,
      });
      // The old key's read-only grace is security-sensitive lifecycle state.
      // Derive it from PostgreSQL's authoritative clock rather than the app host
      // so host/database clock skew cannot shorten or extend the grace window.
      const clock = await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms`);
      const rotatedAtMs = Number(clock.rows[0]?.now_ms);
      if (!Number.isFinite(rotatedAtMs)) throw new Error("Database clock is unavailable");
      const rotatedAt = new Date(rotatedAtMs);
      const readOnlyUntil = new Date(rotatedAtMs + ODOO_KEY_ROTATION_GRACE_MS);
      await tx.update(apiKeys)
        .set({ revokedAt: rotatedAt, readOnlyUntil })
        .where(and(eq(apiKeys.id, old.id), eq(apiKeys.tenantId, manager.tenantId)));
      await writeAuditEvent({
        tenantId: manager.tenantId,
        actorType: manager.userId ? "user" : "system",
        actorId: manager.userId ?? "legacy-manager",
        action: "api_key.rotated",
        resourceType: "api_key",
        resourceId: newId,
        metadata: { replacedKeyId: old.id },
      }, tx);
      return { kind: "rotated" as const, oldId: old.id, newId, raw, name: old.name, readOnlyUntil };
    });

    if (rotated.kind === "not_found") return NextResponse.json({ error: "API key not found" }, { status: 404 });
    if (rotated.kind === "revoked") return NextResponse.json({ error: "Only an active API key can be rotated" }, { status: 409 });

    return NextResponse.json({
      id: rotated.newId,
      replacedKeyId: rotated.oldId,
      name: rotated.name,
      apiKey: rotated.raw,
      readOnlyUntil: rotated.readOnlyUntil.toISOString(),
      note: "Update Odoo with this new key within 60 minutes. The previous key is read-only during that grace window for status reconciliation and cannot create or change jobs. It then becomes fully unusable.",
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logError("[odoo] API key rotation failed", { error: error instanceof Error ? error.message : error });
    return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
