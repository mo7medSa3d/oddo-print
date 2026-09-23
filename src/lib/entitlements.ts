import { sql, type SQL } from "drizzle-orm";
import { logError } from "./log";
import { gatewayNowMs } from "./database-clock";
import type { EntitlementLimitSignal } from "./limit-signal";

export class TenantEntitlementError extends Error {
  readonly code = "TENANT_ENTITLEMENT_EXCEEDED" as const;
  constructor(
    public readonly entitlement: string,
    public readonly limit: number,
    public readonly used: number = limit,
  ) {
    super(`Tenant entitlement ${entitlement} exceeded (limit ${limit})`);
  }
}

export class TenantSubscriptionRequiredError extends Error {
  readonly code = "TENANT_SUBSCRIPTION_REQUIRED" as const;
  constructor() {
    super("An active subscription is required for this operation");
  }
}

/**
 * Stripe subscription states that keep the Yasser runtime provisioned.
 * past_due remains usable while Stripe performs recovery/retry; access is
 * revoked for unpaid/canceled/paused states by the entitlement query.
 */
export const BILLING_ACCESS_STATUSES = ["trialing", "active", "past_due"] as const;

/** True when a Stripe subscription status keeps the runtime provisioned. */
export function isBillingAccessStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && (BILLING_ACCESS_STATUSES as readonly string[]).includes(status);
}

/**
 * Subscription period gate used by every Odoo/console entry point.
 *
 * `current_period_end` is a Stripe/DB timestamp, so it must be compared with
 * the Gateway's authoritative clock (database-calibrated) rather than the Node
 * host clock: a host running ahead would revoke access from a paying tenant
 * (pairing, key creation, and printing all return 403 SUBSCRIPTION_REQUIRED),
 * while a host running behind would keep an expired subscription provisioned.
 *
 * A null period end means "no period boundary recorded yet" and stays live —
 * matching the SQL predicates in `getTenantEntitlementLimit`, which treat
 * `period_end IS NULL` as live for active/trialing rows.
 */
export function isSubscriptionPeriodLive(
  currentPeriodEnd: Date | string | null | undefined,
  nowMs: number = gatewayNowMs(),
): boolean {
  if (currentPeriodEnd === null || currentPeriodEnd === undefined) return true;
  const endsAt = currentPeriodEnd instanceof Date ? currentPeriodEnd.getTime() : parseEntitlementDate(currentPeriodEnd)?.getTime();
  if (typeof endsAt !== "number" || Number.isNaN(endsAt)) return false;
  return endsAt > nowMs;
}

export const PLAN_ENTITLEMENT_KEYS = [
  "max_agents",
  "max_printers",
  "max_jobs_per_minute",
  "max_concurrent_jobs",
  "max_prints_per_period",
] as const;

export type PlanEntitlementKey = typeof PLAN_ENTITLEMENT_KEYS[number];
export type EntitlementValue = number | "unlimited";
export type TenantEntitlements = Record<PlanEntitlementKey, EntitlementValue>;

export const PRINT_QUOTA_ENTITLEMENT = "max_prints_per_period" as const;
export const PRINT_QUOTA_UNIT = "job" as const;

export type TenantPrintUsage = {
  limit: number | "unlimited";
  used: number;
  remaining: number | "unlimited";
  periodStart: Date;
  periodEnd: Date | null;
};

export class TenantPrintQuotaExceededError extends Error {
  readonly code = "PRINT_QUOTA_EXCEEDED" as const;
  readonly entitlement = PRINT_QUOTA_ENTITLEMENT;
  readonly upgradeRequired = true;
  constructor(public readonly limit: number, public readonly used: number, public readonly periodStart: Date, public readonly periodEnd: Date | null) {
    super("Print limit reached for this billing period");
  }
}

export function normalizePlanEntitlements(input: unknown): TenantEntitlements {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("entitlements must be an object");
  const source = input as Record<string, unknown>;
  const result = {} as TenantEntitlements;
  for (const key of PLAN_ENTITLEMENT_KEYS) {
    const value = source[key];
    if (value === "unlimited") { result[key] = value; continue; }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Entitlement ${key} must be a positive integer or "unlimited"`);
    }
    result[key] = value;
  }
  return result;
}
export class TenantEntitlementConfigError extends Error {
  readonly code = "TENANT_ENTITLEMENT_UNAVAILABLE" as const;
  constructor(public readonly entitlement: string) {
    super(`Tenant entitlement ${entitlement} is unavailable`);
  }
}

export type EntitlementTx = { execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }> };

/**
 * Canonical classification for entitlement failures that belong to the
 * billing/forbidden class (HTTP 403) rather than the rate/exceeded class
 * (HTTP 429). Distinct from TenantEntitlementError, which is a momentary
 * limit trip carrying a Retry-After.
 */
export function isTenantBillingError(error: unknown): error is TenantSubscriptionRequiredError | TenantEntitlementConfigError {
  return error instanceof TenantSubscriptionRequiredError || error instanceof TenantEntitlementConfigError;
}

export async function getTenantEntitlementLimit(tx: EntitlementTx, tenantId: string, key: string): Promise<number | null> {
  const result = await tx.execute(sql`
    SELECT p.entitlements
    FROM tenant_subscriptions ts
    JOIN plans p ON p.id = ts.plan_id
    WHERE ts.tenant_id = ${tenantId}
      AND ts.status IN ('trialing','active','past_due')
      AND (
        ts.status = 'past_due'
        OR ts.current_period_end IS NULL
        OR ts.current_period_end > now()
      )
    LIMIT 1
  `);
  if (!result.rows[0]) throw new TenantSubscriptionRequiredError();
  if (!(PLAN_ENTITLEMENT_KEYS as readonly string[]).includes(key)) throw new TenantEntitlementConfigError(key);
  let entitlements: TenantEntitlements;
  try {
    entitlements = normalizePlanEntitlements(result.rows[0].entitlements);
  } catch (err) {
    // normalizePlanEntitlements throws a generic Error for malformed plan data.
    // Log the raw error for internal diagnostics and convert it to a typed
    // TenantEntitlementConfigError so callers produce a sanitized response.
    logError("entitlements.plan_malformed", {
      tenantId,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new TenantEntitlementConfigError(key);
  }
  const value = entitlements[key as PlanEntitlementKey];
  if (value === "unlimited") return null;
  return value;
}

export async function getTenantEntitlements(tx: EntitlementTx, tenantId: string): Promise<TenantEntitlements> {
  const result = await tx.execute(sql`
    SELECT p.entitlements
    FROM tenant_subscriptions ts
    JOIN plans p ON p.id = ts.plan_id
    WHERE ts.tenant_id = ${tenantId}
      AND ts.status IN ('trialing','active','past_due')
      AND (
        ts.status = 'past_due'
        OR ts.current_period_end IS NULL
        OR ts.current_period_end > now()
      )
    LIMIT 1
  `);
  if (!result.rows[0]) throw new TenantSubscriptionRequiredError();
  try {
    return normalizePlanEntitlements(result.rows[0].entitlements);
  } catch (err) {
    // Same as getTenantEntitlementLimit: log raw error and convert to typed error
    // so callers never surface raw internal details in a 500 response.
    logError("entitlements.plan_malformed", {
      tenantId,
      key: "plan_entitlements",
      error: err instanceof Error ? err.message : String(err),
    });
    throw new TenantEntitlementConfigError("plan_entitlements");
  }
}

/**
 * Convert a limit/entitlement failure into the serializable signal the upgrade
 * dialog consumes. Returns null for anything that is not a limit trip, so
 * callers keep their existing error handling for every other failure mode.
 *
 * `retryable` distinguishes a periodic allowance that resets (per-minute rate,
 * concurrent jobs, billing-period quota) from a capacity that only an upgrade
 * can raise (`max_agents`, `max_printers`).
 */
export function entitlementLimitSignal(error: unknown): EntitlementLimitSignal | null {
  if (error instanceof TenantPrintQuotaExceededError) {
    return {
      code: error.code,
      entitlement: error.entitlement,
      limit: error.limit,
      used: error.used,
      remaining: 0,
      periodStart: error.periodStart.toISOString(),
      periodEnd: error.periodEnd?.toISOString() ?? null,
      retryAfterSeconds: error.periodEnd ? Math.max(1, Math.ceil((error.periodEnd.getTime() - gatewayNowMs()) / 1000)) : null,
      upgradeRequired: true,
      message: error.message,
      // The allowance resets at the next billing period, so an immediate retry
      // cannot succeed: `retryAfterSeconds` schedules it instead. Matches the
      // 429 body returned by the HTTP print routes.
      retryable: false,
    };
  }
  if (error instanceof TenantEntitlementError) {
    const capacity = error.entitlement === "max_agents" || error.entitlement === "max_printers";
    return {
      code: error.code,
      entitlement: error.entitlement,
      limit: error.limit,
      used: error.used,
      remaining: Math.max(0, error.limit - error.used),
      retryAfterSeconds: capacity ? null : 60,
      upgradeRequired: true,
      message: error.message,
      retryable: !capacity,
    };
  }
  return null;
}

export async function enforceTenantResourceEntitlement(tx: EntitlementTx, tenantId: string, key: string, currentCountSql: SQL): Promise<void> {
  const limit = await getTenantEntitlementLimit(tx, tenantId, key);
  if (limit === null) return;
  const result = await tx.execute(currentCountSql);
  const count = Number(result.rows[0]?.count ?? 0);
  if (count >= limit) throw new TenantEntitlementError(key, limit, count);
}

type TenantPrintQuotaRow = {
  entitlements: unknown;
  periodStart: Date | string;
  periodEnd: Date | string | null;
};

function parseEntitlementDate(value: Date | string | null): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const text = String(value).trim();
  const iso = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : text.replace(" ", "T") + "Z";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function getTenantPrintQuotaContext(tx: EntitlementTx, tenantId: string, lockRows = false): Promise<{ limit: number | "unlimited"; periodStart: Date; periodEnd: Date | null }> {
  const result = lockRows
    ? await tx.execute(sql`
        SELECT p.entitlements, ts.current_period_start AS "periodStart", ts.current_period_end AS "periodEnd"
        FROM tenant_subscriptions ts
        JOIN plans p ON p.id = ts.plan_id
        WHERE ts.tenant_id = ${tenantId}
          AND ts.status IN ('trialing','active','past_due')
          AND (ts.status = 'past_due' OR ts.current_period_end IS NULL OR ts.current_period_end > now())
        LIMIT 1
        FOR UPDATE OF ts, p
      `)
    : await tx.execute(sql`
        SELECT p.entitlements, ts.current_period_start AS "periodStart", ts.current_period_end AS "periodEnd"
        FROM tenant_subscriptions ts
        JOIN plans p ON p.id = ts.plan_id
        WHERE ts.tenant_id = ${tenantId}
          AND ts.status IN ('trialing','active','past_due')
          AND (ts.status = 'past_due' OR ts.current_period_end IS NULL OR ts.current_period_end > now())
        LIMIT 1
      `);
  const row = result.rows[0] as TenantPrintQuotaRow | undefined;
  if (!row) throw new TenantSubscriptionRequiredError();
  let entitlements: TenantEntitlements;
  try {
    entitlements = normalizePlanEntitlements(row.entitlements);
  } catch (err) {
    logError("entitlements.plan_malformed", { tenantId, key: PRINT_QUOTA_ENTITLEMENT, error: err instanceof Error ? err.message : String(err) });
    throw new TenantEntitlementConfigError(PRINT_QUOTA_ENTITLEMENT);
  }
  const periodStart = parseEntitlementDate(row.periodStart);
  if (!periodStart) throw new TenantEntitlementConfigError("subscription_period");
  const periodEnd = parseEntitlementDate(row.periodEnd);
  if (periodEnd && periodEnd <= periodStart) throw new TenantEntitlementConfigError("subscription_period");
  return { limit: entitlements[PRINT_QUOTA_ENTITLEMENT], periodStart, periodEnd };
}

/** Atomically consumes one print credit for one newly-created logical print job. */
export async function reserveTenantPrintCredit(tx: EntitlementTx, tenantId: string): Promise<TenantPrintUsage> {
  const context = await getTenantPrintQuotaContext(tx, tenantId, true);
  const limit = context.limit;
  const predicate = limit === "unlimited"
    ? sql`TRUE`
    : sql`print_usage_periods.used_prints < ${limit}`;
  const upsert = await tx.execute(sql`
    INSERT INTO print_usage_periods (tenant_id, period_start, period_end, used_prints, created_at, updated_at)
    VALUES (${tenantId}, ${context.periodStart}, ${context.periodEnd}, 1, now(), now())
    ON CONFLICT (tenant_id, period_start)
    DO UPDATE SET
      period_end = EXCLUDED.period_end,
      used_prints = print_usage_periods.used_prints + 1,
      updated_at = now()
    WHERE ${predicate}
    RETURNING used_prints
  `);
  if (upsert.rows.length === 0) {
    const current = await tx.execute(sql`
      SELECT used_prints AS "usedPrints"
      FROM print_usage_periods
      WHERE tenant_id = ${tenantId} AND period_start = ${context.periodStart}
      LIMIT 1
    `);
    const used = Number((current.rows[0] as { usedPrints?: number | string } | undefined)?.usedPrints ?? 0);
    throw new TenantPrintQuotaExceededError(Number(limit), used, context.periodStart, context.periodEnd);
  }
  const used = Number((upsert.rows[0] as { used_prints?: number | string } | undefined)?.used_prints ?? 0);
  return { limit, used, remaining: limit === "unlimited" ? "unlimited" : Math.max(0, Number(limit) - used), periodStart: context.periodStart, periodEnd: context.periodEnd };
}

export async function getTenantPrintUsage(tx: EntitlementTx, tenantId: string): Promise<TenantPrintUsage> {
  const context = await getTenantPrintQuotaContext(tx, tenantId);
  const current = await tx.execute(sql`
    SELECT used_prints AS "usedPrints"
    FROM print_usage_periods
    WHERE tenant_id = ${tenantId} AND period_start = ${context.periodStart}
    LIMIT 1
  `);
  const used = Number((current.rows[0] as { usedPrints?: number | string } | undefined)?.usedPrints ?? 0);
  return { limit: context.limit, used, remaining: context.limit === "unlimited" ? "unlimited" : Math.max(0, Number(context.limit) - used), periodStart: context.periodStart, periodEnd: context.periodEnd };
}
export async function enforceTenantJobEntitlements(tx: EntitlementTx, tenantId: string): Promise<void> {
  const minuteLimit = await getTenantEntitlementLimit(tx, tenantId, "max_jobs_per_minute");
  if (minuteLimit !== null) {
    const recent = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs
      WHERE tenant_id = ${tenantId}
        AND created_at >= now() - interval '1 minute'
    `);
    const count = Number(recent.rows[0]?.count ?? 0);
    if (count >= minuteLimit) throw new TenantEntitlementError("max_jobs_per_minute", minuteLimit, count);
  }

  const concurrentLimit = await getTenantEntitlementLimit(tx, tenantId, "max_concurrent_jobs");
  if (concurrentLimit !== null) {
    const current = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs
      WHERE tenant_id = ${tenantId}
        AND status IN ('queued','claimed','printing')
        AND expires_at > now()
    `);
    const count = Number(current.rows[0]?.count ?? 0);
    if (count >= concurrentLimit) throw new TenantEntitlementError("max_concurrent_jobs", concurrentLimit, count);
  }
}
