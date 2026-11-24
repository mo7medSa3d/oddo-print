import { NextResponse } from "next/server";
import { z } from "zod";
import { isPlatformActionConfirmed, platformActionReason } from "../../../../../../lib/platform-action-confirmation";
import { requirePlatformOwner, PlatformUnauthorizedError, PlatformMutationAuthorityChangedError } from "../../../../../../lib/platform-auth";
import { hasBodyOverLimit } from "../../../../../../lib/request-limits";
import { transitionTenantLifecycle, TenantLifecycleError } from "../../../../../../lib/tenant-lifecycle";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store" };
const schema = z.object({
  // Native modal confirmation: no ID transcription or minimum reason length.
  confirmed: z.literal(true).optional(),
  confirmId: z.string().trim().min(1).max(120).optional(), // legacy clients
  reason: z.string().trim().max(500).optional(),
}).strict();

/** Durable logical workspace deletion. Session/Agent access is revoked and
 * historical billing and print receipts remain for reconciliation and audit. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let actor;
  try { actor = await requirePlatformOwner(req); }
  catch (error) {
    return NextResponse.json({ error: error instanceof PlatformUnauthorizedError ? "Unauthorized" : "Platform authentication temporarily unavailable" },
      { status: error instanceof PlatformUnauthorizedError ? 401 : 503, headers: HEADERS });
  }
  const { id } = await params;
  if (!id || id.length > 120) return NextResponse.json({ error: "Invalid workspace ID" }, { status: 400, headers: HEADERS });
  if (hasBodyOverLimit(req, 4 * 1024)) return NextResponse.json({ error: "Request too large" }, { status: 413, headers: HEADERS });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isPlatformActionConfirmed(parsed.data, id)) return NextResponse.json({ error: "Confirm workspace deletion" }, { status: 400, headers: HEADERS });
  try {
    const result = await transitionTenantLifecycle(id, "deleted", platformActionReason(parsed.data.reason, "workspace deletion"), {
      type: "platform", id: actor.userId, claims: actor,
    });
    if (!result.changed) return NextResponse.json({ error: "Workspace was already deleted" }, { status: 409, headers: HEADERS });
    return NextResponse.json({ ok: true, tenantId: id, lifecycle: "deleted" }, { headers: HEADERS });
  } catch (err) {
    if (err instanceof PlatformMutationAuthorityChangedError) return NextResponse.json({ error: err.message }, { status: 403, headers: HEADERS });
    if (err instanceof TenantLifecycleError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers: HEADERS });
    return NextResponse.json({ error: "Workspace deletion unavailable" }, { status: 503, headers: HEADERS });
  }
}
