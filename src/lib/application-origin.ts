import { requiredRuntimeSecret } from "./runtime-secret";

/** Canonical origin for cookie-authenticated security operations. The value
 * comes from configuration, never an attacker-controlled Host header. */
export function applicationOrigin(): string {
  const url = new URL(requiredRuntimeSecret("APP_BASE_URL"));
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local && process.env.NODE_ENV !== "production"))) {
    throw new Error("APP_BASE_URL must be a clean HTTPS origin (HTTP loopback only in development)");
  }
  return url.origin;
}
