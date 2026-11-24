import { createHash, timingSafeEqual } from "node:crypto";
import { runtimeSecret } from "../lib/runtime-secret";
import { trustProxyEnabled } from "../lib/trust-proxy-config";

function configuredProxySecret(): string | null {
  const value = runtimeSecret("TRUST_PROXY_SECRET")?.trim();
  return value && value.length >= 32 ? value : null;
}

function safeEqual(left: string, right: string): boolean {
  // Hash both inputs to fixed-length SHA-256 digests before comparing,
  // so no code path branches on secret length (matching agent-auth.ts).
  const digestA = createHash("sha256").update(left, "utf8").digest();
  const digestB = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

export { trustProxyEnabled } from "../lib/trust-proxy-config";


function normalizedOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * ASVS 5.0 WebSocket handshake boundary:
 * - native agents normally omit Origin and are accepted;
 * - browser-originated handshakes with an Origin must match the public
 *   application origin or an explicit WS_ALLOWED_ORIGINS allowlist;
 * - wildcard origins are never accepted.
 */
export function isAllowedWebSocketOrigin(originHeader: string | null): boolean {
  // Native (non-browser) agents legitimately omit Origin; such connections are
  // still authenticated via the agent bearer secret in the upgrade handler, so
  // missing Origin alone never grants access. Browser-origin handshakes with an
  // Origin must match the configured allowlist.
  if (!originHeader) return true;
  const supplied = normalizedOrigin(originHeader.trim());
  if (!supplied) return false;

  const configured = new Set<string>();
  // Resolve via runtimeSecret (not process.env directly) so file-mounted
  // secrets (APP_BASE_URL_FILE) work exactly like they do in server.ts.
  const appBaseUrl = runtimeSecret("APP_BASE_URL")?.trim();
  if (appBaseUrl) {
    const origin = normalizedOrigin(appBaseUrl);
    if (origin) configured.add(origin);
  }
  const extra = process.env.WS_ALLOWED_ORIGINS?.split(",") ?? [];
  for (const item of extra) {
    const origin = normalizedOrigin(item.trim());
    if (origin) configured.add(origin);
  }

  return configured.has(supplied);
}

export function isTrustedProxyRequest(
  req: Request | { headers: Headers | Record<string, string | string[] | undefined> },
): boolean {
  if (!trustProxyEnabled()) return true;
  const secret = configuredProxySecret();
  if (!secret) return false;
  const headers = req.headers;
  if (typeof (headers as Headers).get === "function") {
    const raw = (headers as Headers).get("x-gateway-proxy-token")?.trim() ?? "";
    if (!raw || raw.includes(",")) return false;
    return safeEqual(raw, secret);
  }
  return isTrustedProxyUpgrade(headers as Record<string, string | string[] | undefined>);
}

export function isTrustedProxyUpgrade(headers: Record<string, string | string[] | undefined>): boolean {
  if (!trustProxyEnabled()) return true;
  const secret = configuredProxySecret();
  if (!secret) return false;
  const raw = headers["x-gateway-proxy-token"];
  if (Array.isArray(raw)) return false;
  const supplied = (raw ?? "").trim();
  if (!supplied || supplied.includes(",")) return false;
  return safeEqual(supplied, secret);
}
