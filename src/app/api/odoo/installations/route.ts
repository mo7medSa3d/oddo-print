import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { and, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../db";
import { odooInstallations, odooInstallationCredentials } from "../../../../db/schema";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../../lib/manager-mutation-authorization";
import { requireActiveTenantInTransaction, TenantSuspendedError, TenantDeletedError } from "../../../../lib/tenant-guard";
import { requireTenantBillingAccess, isTenantBillingError } from "../../../../lib/entitlements";
import { writeAuditEvent } from "../../../../lib/audit";
import { logError } from "../../../../lib/log";

export const dynamic = "force-dynamic";

const enrollSchema = z.object({
  name: z.string().trim().min(1).max(120),
  apiKeyId: z.string().trim().min(1).max(128),
}).strict();

const INVENTORY_HEADERS = { "Cache-Control": "private, no-store" };

/** Installation identifiers and associated key IDs are authenticated inventory. */
export async function GET(req: Request) {
  const manager = await validateWorkspaceManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: INVENTORY_HEADERS });
  try { requireManagerPermission(manager, "integrations.read"); }
  catch { return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: INVENTORY_HEADERS }); }
  try {
    const rows = await db.transaction(async tx => {
      // Initial session validation cannot authorize a later, unfenced read.
      // Hold both tenant lifecycle and live session/member authority until
      // the inventory query completes, including during concurrent revokes.
      await requireActiveTenantInTransaction(tx, manager.tenantId);
      await requireManagerActorInTransaction(tx, manager, "integrations.read");
      return tx.execute(sql`
        SELECT i.id, i.name, i.enabled, i.created_at, i.disabled_at,
               COALESCE(array_agg(c.api_key_id ORDER BY c.created_at)
                 FILTER (WHERE c.api_key_id IS NOT NULL), ARRAY[]::text[]) AS api_key_ids
        FROM odoo_installations i
        LEFT JOIN odoo_installation_credentials c
          ON c.tenant_id = i.tenant_id AND c.installation_id = i.id
        WHERE i.tenant_id = ${manager.tenantId}
        GROUP BY i.id, i.name, i.enabled, i.created_at, i.disabled_at
        ORDER BY i.created_at DESC
      `);
    });
    return NextResponse.json(rows.rows, { headers: INVENTORY_HEADERS });
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: INVENTORY_HEADERS });
    }
    if (error instanceof TenantSuspendedError || error instanceof TenantDeletedError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403, headers: INVENTORY_HEADERS });
    }
    logError("odoo.installation_inventory_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Installation inventory unavailable" }, { status: 503, headers: INVENTORY_HEADERS });
  }
}

/** Enrollment is operator-only. Never register automatically from a client-controlled database UUID. */
export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large", code: "INVALID_REQUEST" }, { status: 413 });
  const manager = await validateWorkspaceManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(manager, "integrations.manage"); }
  catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const parsed = enrollSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "name and API key are required" }, { status: 400 });
  const installationId = randomUUID();
  const proof = randomBytes(32).toString("base64url");
  const secretHash = createHash("sha256").update(proof).digest("hex");
  try {
    const enrolled = await db.transaction(async (tx) => {
      await requireActiveTenantInTransaction(tx, manager.tenantId);
      // Lock the live credential BEFORE the manager identity guard, just like
      // API-key rotation. Reversing this order can deadlock enrollment against
      // rotation of the same key while the user session is being rechecked.
      const credential = await tx.execute(sql`
        SELECT id FROM api_keys WHERE id = ${parsed.data.apiKeyId} AND tenant_id = ${manager.tenantId}
          AND revoked_at IS NULL AND read_only_until IS NULL AND odoo_enabled = TRUE FOR UPDATE
      `);
      await requireManagerActorInTransaction(tx, manager, "integrations.manage");
      if (!credential.rows.length) return false;
      // This provisioned runtime identity must obey the same manual contract
      // gate as automatic enrollment (and printer/Agent provisioning).
      await requireTenantBillingAccess(tx, manager.tenantId);
      // Migration 0087 deliberately allows a single credential to attest
      // several independent Odoo installations. Their separate 256-bit proofs
      // and versioned operation namespaces prevent cross-installation replay.
      await tx.insert(odooInstallations).values({ id: installationId, tenantId: manager.tenantId, name: parsed.data.name, secretHash });
      await tx.insert(odooInstallationCredentials).values({ tenantId: manager.tenantId, installationId, apiKeyId: parsed.data.apiKeyId });
      await writeAuditEvent({ tenantId: manager.tenantId, actorType: manager.userId ? "user" : "system",
        actorId: manager.userId ?? "legacy-manager", action: "odoo.installation.enrolled",
        resourceType: "odoo_installation", resourceId: installationId, metadata: { keyId: parsed.data.apiKeyId } }, tx);
      return true;
    });
    if (!enrolled) return NextResponse.json({ error: "Active Odoo integration credential required", code: "ENROLLMENT_CONFLICT" }, { status: 409 });
    return NextResponse.json({ installationId, installationProof: proof, note: "Save this 256-bit proof OUTSIDE the Odoo database in YASEIR_ODOO_INSTALLATION_PROOFS. It is shown only once. Restore/clone operations require operator re-enrollment." },
      { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) return error.response();
    if (error instanceof TenantSuspendedError || error instanceof TenantDeletedError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    if (isTenantBillingError(error)) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    logError("odoo.installation.enrollment_failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "Enrollment unavailable" }, { status: 500 });
  }
}
