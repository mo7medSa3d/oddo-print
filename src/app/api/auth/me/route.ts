import { NextResponse } from "next/server";
import { validateManager } from "../../../../lib/manager-auth";
export async function GET(req: Request) { const claims = await validateManager(req); if (!claims) return NextResponse.json({ authenticated: false }, { status: 401 }); return NextResponse.json({ authenticated: true, tenantId: claims.tenantId, userId: claims.userId ?? null, role: claims.role, exp: claims.exp }); }
