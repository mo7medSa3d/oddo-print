import { NextResponse } from "next/server";
import { validatePlatformOwner, revokePlatformSession, clearPlatformCookieHeader } from "../../../../../lib/platform-auth";

export async function POST(req: Request) {
  const claims = await validatePlatformOwner(req);
  if (claims) {
    await revokePlatformSession(claims.jti).catch(() => undefined);
  }
  return NextResponse.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": clearPlatformCookieHeader(),
      },
    }
  );
}
