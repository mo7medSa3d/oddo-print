import { requestPath } from "./request-path";

function createContentSecurityPolicyNonce(): string {
  // A nonce is a secret random value, not an identifier. Generate 256 random
  // bits directly rather than encoding a UUID's fixed-format characters.
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

function buildContentSecurityPolicy(nonce: string, isDevelopment: boolean): string {
  const cspHeader = `
    default-src 'self';
    base-uri 'none';
    object-src 'none';
    frame-ancestors 'none';
    form-action 'self';
    upgrade-insecure-requests;
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""};
    style-src 'self' 'nonce-${nonce}'${isDevelopment ? " 'unsafe-inline'" : ""};
    style-src-attr 'unsafe-inline';
    img-src 'self' data: blob:;
    font-src 'self' data:;
    connect-src 'self';
    worker-src 'self' blob:;
    manifest-src 'self';
    report-uri /api/security/csp-report;
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
  const path = requestPath(url);
  return !path.startsWith("/api/") && !path.startsWith("/_next/") && path !== "/favicon.ico";
}
