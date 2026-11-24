import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { isPlatformActionConfirmed, platformActionReason } from "../../../../../lib/platform-action-confirmation";
import { db } from "../../../../../db";
import { requirePlatformOwner, requirePlatformActorInTransaction,
  PlatformUnauthorizedError, PlatformMutationAuthorityChangedError } from "../../../../../lib/platform-auth";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { deleteApiKeyInTransaction } from "../../../../../lib/api-key-deletion";
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

/** Immediate irreversible credential-row deletion by an authenticated platform owner. */
export async function POST(req: Request) {
  let actor;
  try { actor = await requirePlatformOwner(req); }
  catch (error) {
    return NextResponse.json({ error: error instanceof PlatformUnauthorizedError ? "Unauthorized" : "Platform authentication temporarily unavailable" },
      { status: error instanceof PlatformUnauthorizedError ? 401 : 503, headers: HEADERS });
  }
  if (hasBodyOverLimit(req, 4 * 1024)) return NextResponse.json({ error: "Request too large" }, { status: 413, headers: HEADERS });
  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isPlatformActionConfirmed(parsed.data, parsed.data.id))
    return NextResponse.json({ error: "Confirm this security action" }, { status: 400, headers: HEADERS });
  const { tenantId, id } = parsed.data;
  const reason = platformActionReason(parsed.data.reason, "API key deletion");
  try {
    const result = await db.transaction(async tx => {
      // Serializes concurrent credential mutations for this workspace.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`api_keys:tenant:${tenantId}`}))`);
      await requirePlatformActorInTransaction(tx, actor);
      if (!(await deleteApiKeyInTransaction(tx, tenantId, id)))
        return { status: 404, error: "API key not found" } as const;
      await writeAuditEvent({ tenantId, actorType: "platform", actorId: actor.userId,
        action: "api_key.deleted", resourceType: "api_key", resourceId: id,
        metadata: { reason, credentialDeleted: true, historyReferenceRetained: true } }, tx);
      return { status: 200, ok: true, tenantId, id, removed: true } as const;
    });
    return NextResponse.json(result, { status: result.status, headers: HEADERS });
  } catch (error) {
    if (error instanceof PlatformMutationAuthorityChangedError) return NextResponse.json({ error: error.message }, { status: 403, headers: HEADERS });
    return NextResponse.json({ error: "API key deletion unavailable" }, { status: 503, headers: HEADERS });
  }
}
