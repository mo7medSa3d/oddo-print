// Compatibility-only lifetime for sessions issued before refresh-token cutover.
// New sessions use the shared 15-minute access / 30-day refresh design.
export const LEGACY_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export function sessionCookieSecure(): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return process.env.NODE_ENV === "production";
}
