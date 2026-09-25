import { NextResponse } from "next/server";
import { validateManagerOnly } from "../../../../../lib/manager-auth";

export async function GET(req: Request) {
  const claims = await validateManagerOnly(req);
  if (!claims) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({ authenticated: true, jti: claims.jti, exp: claims.exp, tenantId: claims.tenantId, userId: claims.userId ?? null, role: claims.role });
}
