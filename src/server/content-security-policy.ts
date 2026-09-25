function createContentSecurityPolicyNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

function buildContentSecurityPolicy(nonce: string, isDevelopment: boolean): string {
  const cspHeader = `
    default-src 'self';
    base-uri 'self';
    object-src 'none';
    frame-ancestors 'none';
    form-action 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""};
    style-src 'self' 'nonce-${nonce}'${isDevelopment ? " 'unsafe-inline'" : ""};
    img-src 'self' data: blob:;
    font-src 'self' data:;
    connect-src 'self';
    worker-src 'self' blob:;
    manifest-src 'self';
  `;

  return cspHeader.replace(/\s{2,}/g, " ").trim();
}

export function createRequestContentSecurityPolicy(): { nonce: string; policy: string } {
  const nonce = createContentSecurityPolicyNonce();
  return {
    nonce,
    policy: buildContentSecurityPolicy(nonce, process.env.NODE_ENV === "development"),
  };
}

export function shouldApplyPageContentSecurityPolicy(url: string | undefined): boolean {
  if (!url) return true;
  const path = url.split("?", 1)[0] ?? "/";
  return !path.startsWith("/api/") && !path.startsWith("/_next/") && path !== "/favicon.ico";
}
