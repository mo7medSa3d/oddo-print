import { sessionCookieName } from "../../../../lib/session-config";
import { readCookie } from "../../../../lib/session-tokens";
import { NextResponse } from "next/server";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { managerPermissions } from "../../../../lib/authorization";
export async function GET(req: Request) {
  let claims: Awaited<ReturnType<typeof validateWorkspaceManager>>;
  try {
    claims = await validateWorkspaceManager(req);
  } catch {
    return NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  // Deliberate probe shape: clients check `res.ok` (AppShell, dashboard,
  // login). The 401 body uses the standard `{error}` shape so shared client
  // error handling treats it like every other route; the 2xx body keeps the
  // `authenticated` flag the probe contract documents.
  if (!claims) return NextResponse.json({ error: "Unauthorized", refreshKind: readCookie(req, sessionCookieName("manager")) !== null ? "manager" : "customer" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ authenticated: true, tenantId: claims.tenantId, userId: claims.userId ?? null, role: claims.role, kind: claims.kind ?? "manager", permissions: managerPermissions(claims), exp: claims.exp }, { headers: { "Cache-Control": "no-store" } });
}
