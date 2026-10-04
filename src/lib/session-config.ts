// Compatibility-only lifetime for sessions issued before refresh-token cutover.
// New sessions use the shared 15-minute access / 30-day refresh design.
export const LEGACY_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export function sessionCookieSecure(): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return process.env.NODE_ENV === "production";
}

let customerSessionFlight: Promise<{ authenticated: boolean; expiresAt: number }> | null = null;
/** Shared browser admission for one refresh, including other tabs where Web Locks exist. */
export function ensureCustomerSession(): Promise<{ authenticated: boolean; expiresAt: number }> {
  if (customerSessionFlight) return customerSessionFlight;
  const check = async () => {
    const probe = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
    const body = await probe.json();
    if (probe.ok) {
      if (typeof body?.exp === "number" && body.exp * 1000 > Date.now() + 60000) return { authenticated: true, expiresAt: body.exp * 1000 };
    } else if (probe.status !== 401) throw new Error("Session probe temporarily unavailable");
    const kind = body?.kind === "manager" || body?.refreshKind === "manager" ? "manager" : "customer";
    let response = await fetch(kind === "manager" ? "/api/auth/manager/refresh" : "/api/auth/refresh", { method: "POST", credentials: "include", cache: "no-store" });
    // A stale manager cookie must not shadow a live customer refresh family.
    if (response.status === 401 && kind === "manager") response = await fetch("/api/auth/refresh", { method: "POST", credentials: "include", cache: "no-store" });
    if (response.status === 401) return { authenticated: false, expiresAt: 0 };
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
