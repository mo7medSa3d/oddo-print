import { NextRequest, NextResponse } from "next/server";

function createNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

function buildContentSecurityPolicy(nonce: string, isDev: boolean): string {
  const cspHeader = `
    default-src 'self';
    base-uri 'self';
    object-src 'none';
    frame-ancestors 'none';
    form-action 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""};
    style-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-inline'" : ""};
    img-src 'self' data: blob:;
    font-src 'self' data:;
    connect-src 'self';
    worker-src 'self' blob:;
    manifest-src 'self';
  `;

  return cspHeader.replace(/\\s{2,}/g, " ").trim();
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const cspHeader = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === "development");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", cspHeader);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set("Content-Security-Policy", cspHeader);
  return response;
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
