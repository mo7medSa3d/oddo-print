import { createHash, timingSafeEqual } from "node:crypto";
import { runtimeSecret } from "../lib/runtime-secret";

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

export function trustProxyEnabled(): boolean {
  return process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
}


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
  if (!originHeader) return true;
  const supplied = normalizedOrigin(originHeader.trim());
  if (!supplied) return false;

  const configured = new Set<string>();
  const appBaseUrl = process.env.APP_BASE_URL?.trim();
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

export function isTrustedProxyRequest(req: Request): boolean {
  if (!trustProxyEnabled()) return true;
  const secret = configuredProxySecret();
  if (!secret) return false;
  const supplied = req.headers.get("x-gateway-proxy-token")?.trim() ?? "";
  return supplied.length > 0 && safeEqual(supplied, secret);
}

export function isTrustedProxyUpgrade(headers: Record<string, string | string[] | undefined>): boolean {
  if (!trustProxyEnabled()) return true;
  const secret = configuredProxySecret();
  if (!secret) return false;
  const raw = headers["x-gateway-proxy-token"];
  const supplied = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  return supplied.trim().length > 0 && safeEqual(supplied.trim(), secret);
}
