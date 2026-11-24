import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db";
import { validateWorkspaceManager } from "../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../../../lib/manager-mutation-authorization";
import { requireActiveTenantInTransaction } from "../../../../../lib/tenant-guard";
import { writeAuditEvent } from "../../../../../lib/audit";
import { logError } from "../../../../../lib/log";

export const dynamic = "force-dynamic";
const schema = z.object({
  mode: z.literal("strict_v2"),
  verifiedExternalOutboxes: z.literal(true),
  verifiedReceiptBackup: z.literal(true),
  verifiedAllInstallationsEnrolled: z.literal(true),
}).strict();

/** One-way by design: flips odoo_idempotency_mode to strict_v2. */
export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large", code: "INVALID_REQUEST" }, { status: 413 });
  const manager = await validateWorkspaceManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(manager, "integrations.manage"); }
  catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Explicit outbox, receipt and enrollment attestations required" }, { status: 400 });
  try {
    const state = await db.transaction(async (tx) => {
      // Acquire the exclusive tenant fence FIRST to prevent lock-upgrade deadlocks.
      const tenant = await tx.execute(sql`
        SELECT odoo_idempotency_mode AS mode FROM tenants
        WHERE id = ${manager.tenantId} FOR UPDATE
      `);
      await requireActiveTenantInTransaction(tx, manager.tenantId);
      await requireManagerActorInTransaction(tx, manager, "integrations.manage");
      if (tenant.rows[0]?.mode === "strict_v2") return "already_active";
      const count = await tx.execute(sql`
        SELECT COUNT(*)::int AS count FROM odoo_installations
        WHERE tenant_id = ${manager.tenantId} AND enabled = TRUE
      `);
      if (Number(count.rows[0]?.count ?? 0) < 1) return "missing_installations";
      await tx.execute(sql`UPDATE tenants SET odoo_idempotency_mode = 'strict_v2', updated_at = clock_timestamp() WHERE id = ${manager.tenantId}`);
      await writeAuditEvent({ tenantId: manager.tenantId, actorType: manager.userId ? "user" : "system",
        actorId: manager.userId ?? "legacy-manager", action: "odoo.idempotency.strict_cutover",
        resourceType: "tenant", resourceId: manager.tenantId,
        metadata: { externalOutboxVerified: true, receiptBackupVerified: true, allInstallationsEnrolled: true } }, tx);
      return "activated";
    });
    if (state === "missing_installations") {
      return NextResponse.json({ error: "Cutover preflight failed", code: state.toUpperCase() }, { status: 409 });
    }
    return NextResponse.json({ mode: "strict_v2", state }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) return error.response();
    logError("odoo.idempotency.cutover_failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "Cutover unavailable" }, { status: 500 });
  }
}
