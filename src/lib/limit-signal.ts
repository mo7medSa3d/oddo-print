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
  /** Only billable print allowance offers a subscription change; physical
   * Agent/printer and burst safety limits still show a bounded technical notice. */
  upgradeRequired: boolean;
  message: string;
  retryable: boolean;
};

/** Field mapping shared by server-action and Dashboard to prevent using the
 * removed `max` property. `limit` is the exact server/DB entitlement amount. */
export function limitSignalDisplayDetails(signal: EntitlementLimitSignal): {
  used: number | null;
  limit: EntitlementValue | null;
  periodEnd: string | null;
  retryAfterSeconds: number | null;
} {
  return {
    used: signal.used,
    limit: signal.limit,
    periodEnd: signal.periodEnd ?? null,
    retryAfterSeconds: signal.retryAfterSeconds ?? null,
  };
}

/** Returned (never thrown) by client-invoked server actions on a limit trip. */
export type LimitSignalResult = { ok: false; limit: EntitlementLimitSignal };

export function isLimitSignalResult(value: unknown): value is LimitSignalResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { ok?: unknown; limit?: unknown };
  if (candidate.ok !== false || !candidate.limit || typeof candidate.limit !== "object") return false;
  const limit = candidate.limit as { entitlement?: unknown; upgradeRequired?: unknown };
  return typeof limit.entitlement === "string" && typeof limit.upgradeRequired === "boolean";
}
