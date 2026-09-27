import { NextResponse } from "next/server";
import { validateManager } from "../../../../../lib/manager-auth";

export async function GET(req: Request) {
  const claims = await validateManager(req);
  // Standard error shape on 401 (the desktop IPC keys off the status code,
  // not the body); the 2xx probe body keeps its `authenticated` flag.
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ authenticated: true, jti: claims.jti, exp: claims.exp, tenantId: claims.tenantId, userId: claims.userId ?? null, role: claims.role });
}
