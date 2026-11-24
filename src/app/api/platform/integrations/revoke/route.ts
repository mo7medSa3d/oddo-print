import { NextResponse } from "next/server";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { isPlatformActionConfirmed, platformActionReason } from "../../../../../lib/platform-action-confirmation";
import { db } from "../../../../../db";
import { apiKeys } from "../../../../../db/schema";
import {
  requirePlatformOwner, requirePlatformActorInTransaction,
  PlatformUnauthorizedError, PlatformMutationAuthorityChangedError,
} from "../../../../../lib/platform-auth";
import { writeAuditEvent } from "../../../../../lib/audit";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";

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

/** Emergency deny-list: does NOT rotate, expose or mint integration credentials. */
export async function POST(req: Request) {
  let actor;
  try { actor = await requirePlatformOwner(req); }
  catch (error) {
    return NextResponse.json({ error: error instanceof PlatformUnauthorizedError ? "Unauthorized" : "Platform authentication temporarily unavailable" },
      { status: error instanceof PlatformUnauthorizedError ? 401 : 503, headers: HEADERS });
  }
  if (hasBodyOverLimit(req, 4 * 1024)) return NextResponse.json({ error: "Request too large" }, { status: 413, headers: HEADERS });
  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isPlatformActionConfirmed(parsed.data, parsed.data.id)) {
    return NextResponse.json({ error: "Confirm this security action" }, { status: 400, headers: HEADERS });
  }
  const { tenantId, id } = parsed.data;
  const reason = platformActionReason(parsed.data.reason, "API key revocation");
  try {
    const result = await db.transaction(async tx => {
      const rows = await tx.select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt, readOnlyUntil: apiKeys.readOnlyUntil })
        .from(apiKeys).where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, id))).for("update");
      // Keep the resource FOR UPDATE before the session/user lock for
      // consistent writer lock ordering, but never reveal resource state to
      // a principal revoked after the HTTP authorization preflight.
      await requirePlatformActorInTransaction(tx, actor);
      if (!rows[0]) return { status: 404, error: "API key not found" } as const;
      if (rows[0].revokedAt && !rows[0].readOnlyUntil) return { status: 409, error: "API key has no remaining access" } as const;
      // Revocation must be immediately final: remove any old read-only rotation
      // grace, otherwise the credential could still read historical receipts.
      const revoked = await tx.update(apiKeys)
        .set({
          revokedAt: sql`COALESCE(${apiKeys.revokedAt}, clock_timestamp())`,
          readOnlyUntil: null,
          odooEnabled: false,
          odooEnabledRevision: sql`LEAST(${apiKeys.odooEnabledRevision}, 2147483646) + 1`,
          odooEnabledUpdatedAt: sql`clock_timestamp()`,
        })
        // A rotated key is already marked revoked, but remains authorized to
        // read historical receipts until readOnlyUntil. End that grace too.
        .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, id),
          or(isNull(apiKeys.revokedAt), isNotNull(apiKeys.readOnlyUntil))))
        .returning({ id: apiKeys.id });
      if (revoked.length !== 1) return { status: 409, error: "API key changed; reload the inventory" } as const;
      await writeAuditEvent({
        tenantId, actorType: "platform", actorId: actor.userId,
        action: "api_key.emergency_revoked", resourceType: "api_key", resourceId: id,
        metadata: { reason, scope: "integration", effect: "immediate", removedRotationGrace: Boolean(rows[0].readOnlyUntil) },
      }, tx);
      return { status: 200, ok: true, tenantId, id, revoked: true } as const;
    });
    return NextResponse.json(result, { status: result.status, headers: HEADERS });
  } catch (error) {
    if (error instanceof PlatformMutationAuthorityChangedError) return NextResponse.json({ error: error.message }, { status: 403, headers: HEADERS });
    return NextResponse.json({ error: "API key revocation unavailable" }, { status: 503, headers: HEADERS });
  }
}
