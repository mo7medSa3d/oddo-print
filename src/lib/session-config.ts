// Compatibility-only lifetime for sessions issued before refresh-token cutover.
// New sessions use the shared 15-minute access / 30-day refresh design.
export const LEGACY_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

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

export type RefreshKind = "manager" | "customer";

/**
 * Refresh endpoint attempt order for one recovery round. The indicated kind
 * goes first; the other follows on 401.
 *
 * The manager refresh cookie is scoped to Path=/api/auth/manager, so the
 * /api/auth/me probe cannot see it: after the 15-minute manager access
 * cookie expires, the browser stops sending it and the probe can no longer
 * tell a manager session from "signed out". Trying both endpoints (bounded)
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
  return fetch(url, { ...init, signal: AbortSignal.timeout(SESSION_FETCH_TIMEOUT_MS) });
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
