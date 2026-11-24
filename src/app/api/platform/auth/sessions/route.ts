import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "../../../../../db";
import { validatePlatformOwner, requirePlatformReadAuthorityInTransaction, PlatformUnauthorizedError, PlatformMutationAuthorityChangedError, clearPlatformCookieHeader, clearPlatformRefreshCookieHeader } from "../../../../../lib/platform-auth";
import { listOwnSessions, revokeOwnSessions, SessionInventoryRequestError } from "../../../../../lib/session-inventory";
import { WorkspaceSessionExpiredError } from "../../../../../lib/workspace-session-security";
import { assertWorkspaceSecurityOrigin, WorkspaceSecurityRequestError } from "../../../../../lib/workspace-session-http";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store" };
const inputSchema = z.object({ action: z.enum(["revoke", "revoke_others", "revoke_all"]), id: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict();

export async function GET(req: Request) {
  try {
    const claims = await validatePlatformOwner(req);
    if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: HEADERS });
    const cursors = new URL(req.url).searchParams.getAll("cursor");
    if (cursors.length > 1) throw new SessionInventoryRequestError();
    const snapshot = await db.transaction(async tx => {
      await requirePlatformReadAuthorityInTransaction(tx, claims);
      return listOwnSessions({ scope: "platform", claims }, cursors[0], tx);
    });
    return NextResponse.json(snapshot, { headers: HEADERS });
  } catch (error) {
    if (error instanceof SessionInventoryRequestError) return NextResponse.json({ error: error.message, code: "INVALID_SESSION_CURSOR" }, { status: 400, headers: HEADERS });
    if (error instanceof WorkspaceSessionExpiredError || error instanceof PlatformUnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: HEADERS });
    return NextResponse.json({ error: "Session inventory temporarily unavailable" }, { status: 503, headers: HEADERS });
  }
}

export async function POST(req: Request) {
  try {
    assertWorkspaceSecurityOrigin(req);
    const claims = await validatePlatformOwner(req);
    if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: HEADERS });
    if (hasBodyOverLimit(req, 2048)) return NextResponse.json({ error: "Request too large" }, { status: 413, headers: HEADERS });
    const parsed = inputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: HEADERS });
    const result = await revokeOwnSessions({ scope: "platform", claims }, parsed.data.action, parsed.data.id);
    if (!result.found) return NextResponse.json({ error: "Session not found" }, { status: 404, headers: HEADERS });
    const response = NextResponse.json({ ok: true, found: result.found, revoked: result.revoked, signedOut: result.signedOut }, { headers: HEADERS });
    if (result.signedOut) {
      response.headers.append("Set-Cookie", clearPlatformCookieHeader());
      response.headers.append("Set-Cookie", clearPlatformRefreshCookieHeader());
    }
    return response;
  } catch (error) {
    if (error instanceof WorkspaceSecurityRequestError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: HEADERS });
    if (error instanceof PlatformMutationAuthorityChangedError) return NextResponse.json({ error: "Your platform authorization changed. Sign in again.", code: "PLATFORM_AUTHORITY_CHANGED" }, { status: 403, headers: HEADERS });
    return NextResponse.json({ error: "Session revocation temporarily unavailable" }, { status: 503, headers: HEADERS });
  }
}
