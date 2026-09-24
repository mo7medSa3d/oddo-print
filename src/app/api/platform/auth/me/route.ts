import { NextResponse } from "next/server";
import { validatePlatformOwner } from "../../../../../lib/platform-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const claims = await validatePlatformOwner(req);
  if (!claims) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({
    authenticated: true,
    userId: claims.userId,
    email: claims.email,
    exp: claims.exp,
  });
}
