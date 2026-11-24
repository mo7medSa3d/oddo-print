import { NextResponse } from "next/server";
import { validateManager } from "../../../../../lib/manager-auth";

export const dynamic = "force-dynamic";
const SESSION_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: Request) {
  let claims: Awaited<ReturnType<typeof validateManager>>;
  try {
    claims = await validateManager(req);
  } catch {
    return NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503, headers: SESSION_HEADERS });
  }
  // Standard error shape on 401 (the desktop IPC keys off the status code,
  // not the body); the 2xx probe body keeps its `authenticated` flag.
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: SESSION_HEADERS });
  return NextResponse.json({ authenticated: true, jti: claims.jti, exp: claims.exp, tenantId: claims.tenantId, userId: claims.userId ?? null, role: claims.role }, { headers: SESSION_HEADERS });
}
