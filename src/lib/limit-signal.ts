/**
 * Serializable entitlement-limit signal.
 *
 * The quota/upgrade dialog needs machine-readable limit details
 * (`entitlement`, `limit`, `used`, `periodEnd`, `upgradeRequired`). Those travel
 * to the browser in two very different ways:
 *
 *  - HTTP routes put them in the JSON body of a 429/403 response.
 *  - Server actions cannot throw them: Next.js serializes only a sanitized
 *    message for a thrown error in a production build, so `ActionError.details`
 *    never reaches the client and the dialog would silently stay closed. A
 *    server action that must drive the dialog therefore RETURNS this object.
 *
 * This module is intentionally dependency-free so both the server (actions, lib)
 * and the client (dashboard) can share one shape and one type guard.
 */

import type { EntitlementValue } from "./entitlements";

/** Canonical entitlement keys the dialog knows how to render. */
export const LIMIT_SIGNAL_ENTITLEMENTS = [
  "max_agents",
  "max_printers",
  "max_jobs_per_minute",
  "max_concurrent_jobs",
  "max_prints_per_period",
] as const;

export type EntitlementLimitSignal = {
  /** Machine code, e.g. `PRINT_QUOTA_EXCEEDED` or `TENANT_ENTITLEMENT_EXCEEDED`. */
  code: string;
  /** Which plan entitlement was hit; the client maps it to a dialog resource. */
  entitlement: string;
  /** Configured plan limit. `null` when the Gateway could not read a finite limit. */
  limit: EntitlementValue | null;
  used: number | null;
  remaining: number | "unlimited" | null;
  /** Billing-period boundaries (ISO 8601), for period-based limits. */
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Relative wait, seconds, computed on the authoritative Gateway clock. */
  retryAfterSeconds?: number | null;
  /** Always true: tells the client to offer the upgrade path, not just an error. */
  upgradeRequired: true;
  message: string;
  retryable: boolean;
};

/** Returned (never thrown) by client-invoked server actions on a limit trip. */
export type LimitSignalResult = { ok: false; limit: EntitlementLimitSignal };

export function isLimitSignalResult(value: unknown): value is LimitSignalResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { ok?: unknown; limit?: unknown };
  if (candidate.ok !== false || !candidate.limit || typeof candidate.limit !== "object") return false;
  const limit = candidate.limit as { entitlement?: unknown; upgradeRequired?: unknown };
  return typeof limit.entitlement === "string" && limit.upgradeRequired === true;
}
