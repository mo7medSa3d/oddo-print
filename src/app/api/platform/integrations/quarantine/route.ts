import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { isPlatformActionConfirmed, platformActionReason } from "../../../../../lib/platform-action-confirmation";
import { db } from "../../../../../db";
import { odooInstallations } from "../../../../../db/schema";
import {
  requirePlatformOwner, requirePlatformActorInTransaction,
  PlatformUnauthorizedError, PlatformMutationAuthorityChangedError,
} from "../../../../../lib/platform-auth";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { writeAuditEvent } from "../../../../../lib/audit";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store" };
const inputSchema = z.object({
  tenantId: z.string().trim().min(1).max(120),
  id: z.string().trim().min(1).max(150),
  // Native modal confirmation: no ID transcription or minimum reason length.
  confirmed: z.literal(true).optional(),
  confirmId: z.string().trim().min(1).max(150).optional(), // legacy clients
  reason: z.string().trim().max(500).optional(),
}).strict();

/** Fail-closed stop of new Odoo-v2 admission, not a replay or migration cutover. */
export async function POST(req: Request) {
  let actor;
  try { actor = await requirePlatformOwner(req); }
  catch (error) {
    return NextResponse.json({ error: error instanceof PlatformUnauthorizedError ? "Unauthorized" : "Platform authentication temporarily unavailable" },
      { status: error instanceof PlatformUnauthorizedError ? 401 : 503, headers: HEADERS });
  }
  if (hasBodyOverLimit(req, 4 * 1024)) return NextResponse.json({ error: "Request too large" }, { status: 413, headers: HEADERS });
  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isPlatformActionConfirmed(parsed.data, parsed.data.id)) return NextResponse.json({ error: "Confirm this security action" }, { status: 400, headers: HEADERS });
  const { tenantId, id } = parsed.data;
  const reason = platformActionReason(parsed.data.reason, "installation quarantine");
  try {
    const result = await db.transaction(async tx => {
      const rows = await tx.select({ id: odooInstallations.id, enabled: odooInstallations.enabled })
        .from(odooInstallations).where(and(eq(odooInstallations.tenantId, tenantId), eq(odooInstallations.id, id))).for("update");
      // Acquire the installation row lock before user/session authority as
      // before; a stale Platform Owner may not observe existence or state.
      await requirePlatformActorInTransaction(tx, actor);
      if (!rows[0]) return { status: 404, error: "Installation not found" } as const;
      if (!rows[0].enabled) return { status: 409, error: "Installation already quarantined" } as const;
      const disabled = await tx.update(odooInstallations)
        .set({ enabled: false, disabledAt: sql`clock_timestamp()` })
        .where(and(eq(odooInstallations.id, id), eq(odooInstallations.tenantId, tenantId), eq(odooInstallations.enabled, true)))
        .returning({ id: odooInstallations.id });
      if (disabled.length !== 1) return { status: 409, error: "Installation changed; reload" } as const;
      await writeAuditEvent({
        tenantId, actorType: "platform", actorId: actor.userId,
        action: "odoo_installation.quarantined", resourceType: "odoo_installation", resourceId: id,
        metadata: { reason, effect: "block_new_v2_admission", requiresNewProofForRecovery: true },
      }, tx);
      return { status: 200, ok: true, id, tenantId, quarantined: true } as const;
    });
    return NextResponse.json(result, { status: result.status, headers: HEADERS });
  } catch (error) {
    if (error instanceof PlatformMutationAuthorityChangedError) return NextResponse.json({ error: error.message }, { status: 403, headers: HEADERS });
    return NextResponse.json({ error: "Odoo installation quarantine unavailable" }, { status: 503, headers: HEADERS });
  }
}
