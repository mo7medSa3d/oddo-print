import { NextResponse } from "next/server";
import { validatePlatformOwner } from "../../../../../lib/platform-auth";

export const dynamic = "force-dynamic";
const SESSION_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: Request) {
  let claims: Awaited<ReturnType<typeof validatePlatformOwner>>;
  try {
    claims = await validatePlatformOwner(req);
  } catch {
    return NextResponse.json({ error: "Platform authentication temporarily unavailable" }, { status: 503, headers: SESSION_HEADERS });
  }
  // Standard error shape on 401, matching the other session probes.
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: SESSION_HEADERS });
  return NextResponse.json({
    authenticated: true,
    userId: claims.userId,
    email: claims.email,
    exp: claims.exp,
  }, { headers: SESSION_HEADERS });
}
