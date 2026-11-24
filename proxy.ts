import { NextRequest, NextResponse } from "next/server";

/**
 * The application is served through the repository's custom Node server
 * (server.ts), which owns the request-scoped CSP nonce. Keep this proxy as a
 * transparent pass-through so a second CSP/nonce cannot be minted if Next.js
 * evaluates the file in another hosting mode.
 */
export function proxy(_request: NextRequest): NextResponse {
  return NextResponse.next();
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
