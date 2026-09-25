const DEFAULT_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export const SESSION_MAX_AGE_SECONDS = DEFAULT_SESSION_MAX_AGE_SECONDS;

export function sessionCookieSecure(): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return process.env.NODE_ENV === "production";
}
