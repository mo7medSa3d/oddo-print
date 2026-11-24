// Historical shape bound for revoking pre-policy tokens; these tokens are no
// longer admitted. Human workspace sessions use 15-minute access, 30-minute
// inactivity and an original 30-day absolute family deadline.
//
// Session + cookie policy as implemented (see SECURITY.md for the full table;
// this comment documents, it does not configure — the values live in
// session-tokens.ts, workspace-session-security.ts and
// platform-session-security.ts):
// - Workspace (manager + customer): access 15 min; idle 30 min since
//   last_seen_at, extended ONLY by trusted-input activity
//   (POST /api/auth/activity); refresh and polling never extend it;
//   absolute 30 days from family creation, never extended by refresh.
//   No step-up: a valid session authorizes sensitive mutations too.
// - Platform owner: access 15 min; idle 30 min; absolute 8 h.
//   Data requests extend platform last_seen_at except /me, /refresh.
// - No Remember Me exists: no flag in any login UI or login API, and none
//   was added here — adding one would create a second session system.
// - Refresh rotates every success (SHA-256 hash storage only), with a 5 s
//   grace window in which a re-presented token rotates again and revokes
//   the previous successor; presentation after grace revokes the whole
//   family (refresh_reuse_detected) with audit + notification email.
//   Workspace policy / principal failure on refresh likewise revokes the
//   family (workspace_session_expired / principal_invalid).
// - Cookies: HttpOnly, never in browser storage. Access names
//   mgr/cust/plt_session, Path=/, SameSite=Lax, Max-Age 900 s. Refresh
//   names mgr/cust/plt_refresh, SameSite=Strict; Path=/ in production,
//   per-endpoint (/api/auth/manager, /api/auth, /api/platform/auth) in
//   non-production; Max-Age 30 days (workspace) / 8 h (platform). Names
//   are `__Host-` prefixed in production, bare otherwise; Secure always in
//   production, otherwise only with COOKIE_SECURE=1/true.
// - Failed refresh answers 401 with `{ error, code }` and clears both
//   cookie pairs of that kind. Codes (RefreshFailureCode in
//   session-tokens.ts): REFRESH_TOKEN_REQUIRED (no token presented),
//   REFRESH_TOKEN_INVALID, REFRESH_TOKEN_REVOKED, REFRESH_TOKEN_REUSED,
//   REFRESH_TOKEN_EXPIRED, TENANT_SUSPENDED, TENANT_DELETED,
//   PRINCIPAL_INVALID, SESSION_IDLE_EXPIRED, WORKSPACE_SESSION_EXPIRED,
//   PLATFORM_SESSION_EXPIRED. The idle code fires only when the policy
//   row's last_seen_at is already past the 30-minute fence; other policy
//   deaths stay merged under the workspace/platform session-expired code.
//   Client wording: no dedicated EN+AR "signed out due to inactivity" key
//   exists yet, so clients map all of these to the existing
//   `errors.sessionExpired` key; the server's English fallback string for
//   SESSION_IDLE_EXPIRED is "Session expired due to inactivity".
export const LEGACY_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Production cutover deliberately does not read the old unprefixed cookies. */
export function sessionCookieName(kind: "manager" | "customer" | "platform", refresh = false): string {
  const base = kind === "manager" ? "mgr" : kind === "customer" ? "cust" : "plt";
  const prefix = process.env.NODE_ENV === "production" ? "__Host-" : "";
  return `${prefix}${base}_${refresh ? "refresh" : "session"}`;
}

/** Expire obsolete scoped/host-unbound cookies during the production cutover. */
export function clearLegacySessionCookies(headers: Headers, kind: "manager" | "customer" | "platform"): void {
  if (process.env.NODE_ENV !== "production") return;
  const base = kind === "manager" ? "mgr" : kind === "customer" ? "cust" : "plt";
  const path = kind === "manager" ? "/api/auth/manager" : kind === "customer" ? "/api/auth" : "/api/platform/auth";
  for (const [name, cookiePath] of [[`${base}_session`, "/"], [`${base}_refresh`, path], [`__Secure-${base}_refresh`, path]]) {
    headers.append("Set-Cookie", `${name}=; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  }
}

export function sessionCookieSecure(): boolean {
  // Production sessions are always transport-secure. Never allow an
  // environment typo or stale development override to remove the Secure
  // attribute from authentication cookies in a production deployment.
  if (process.env.NODE_ENV === "production") return true;

  const override = process.env.COOKIE_SECURE;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return false;
}

let customerSessionFlight: Promise<{ authenticated: boolean; expiresAt: number }> | null = null;

type RefreshKind = "manager" | "customer";

/**
 * Refresh endpoint attempt order for one recovery round. The indicated kind
 * goes first; the other follows on 401.
 *
 * The nonproduction manager refresh cookie is scoped to /api/auth/manager, so the
 * /api/auth/me probe cannot see it: after the 15-minute manager access
 * cookie expires, the browser stops sending it and the probe can no longer
 * tell a manager session from "signed out". Production cookies use Path=/;
 * the bounded two-endpoint recovery also preserves the nonproduction flow.
 * Trying both endpoints (bounded)
 * recovers through the live family instead of misreporting signed out.
 * Pure function of its input so the precedence is unit-pinned.
 */
export function refreshEndpointOrder(primaryKind: RefreshKind): [string, string] {
  const managerEndpoint = "/api/auth/manager/refresh";
  const customerEndpoint = "/api/auth/refresh";
  return primaryKind === "manager"
    ? [managerEndpoint, customerEndpoint]
    : [customerEndpoint, managerEndpoint];
}

const SESSION_FETCH_TIMEOUT_MS = 10_000;

async function fetchWithSessionTimeout(url: string, init: RequestInit): Promise<Response> {
  // Keep the deadline attached after fetch() resolves headers: callers also
  // await response.json(), and a stalled body must not pin session admission.
  return fetch(url, { redirect: "error", ...init, signal: AbortSignal.timeout(SESSION_FETCH_TIMEOUT_MS) });
}
/** Shared browser admission for one refresh, including other tabs where Web Locks exist. */
export function ensureCustomerSession(): Promise<{ authenticated: boolean; expiresAt: number }> {
  if (customerSessionFlight) return customerSessionFlight;
  const check = async () => {
    const probe = await fetchWithSessionTimeout("/api/auth/me", { credentials: "include", cache: "no-store" });
    const body = await probe.json();
    if (probe.ok) {
      if (typeof body?.exp === "number" && body.exp * 1000 > Date.now() + 60000) return { authenticated: true, expiresAt: body.exp * 1000 };
    } else if (probe.status !== 401) throw new Error("Session probe temporarily unavailable");
    const primaryKind: RefreshKind = body?.kind === "manager" || body?.refreshKind === "manager" ? "manager" : "customer";
    let response: Response | null = null;
    for (const endpoint of refreshEndpointOrder(primaryKind)) {
      response = await fetchWithSessionTimeout(endpoint, { method: "POST", credentials: "include", cache: "no-store" });
      if (response.status !== 401) break;
    }
    if (!response || response.status === 401) return { authenticated: false, expiresAt: 0 };
    if (!response.ok) throw new Error("Session refresh temporarily unavailable");
    const refreshed = await response.json();
    const expiresAt = Date.parse(refreshed.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error("Invalid session expiry");
    return { authenticated: true, expiresAt };
  };
  const flight = Promise.resolve(typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("yaseir:customer-session", check) : check())
    .finally(() => { customerSessionFlight = null; });
  customerSessionFlight = flight;
  return flight;
}
