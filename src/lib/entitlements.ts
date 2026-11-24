import { sql, type SQL } from "drizzle-orm";
import { quotaCycleStartSql, quotaCycleEndSql } from "./quota-cycle";
import { logError } from "./log";
import { parseDbTimeMs } from "./database-timestamp";
import { TenantDeletedError, TenantSuspendedError } from "./tenant-guard";

export class TenantSubscriptionRequiredError extends Error {
  readonly code = "TENANT_SUBSCRIPTION_REQUIRED" as const;
  constructor() {
    super("An active subscription is required for this operation");
  }
}

const PLAN_ENTITLEMENT_KEYS = [
  "max_agents",
  "max_printers",
  "max_jobs_per_minute",
  "max_concurrent_jobs",
  "max_prints_per_period",
] as const;

type PlanEntitlementKey = typeof PLAN_ENTITLEMENT_KEYS[number];
export type EntitlementValue = number | "unlimited";
type TenantEntitlements = Record<PlanEntitlementKey, EntitlementValue>;

const PRINT_QUOTA_ENTITLEMENT = "max_prints_per_period" as const;

export type TenantPrintUsage = {
  limit: number | "unlimited";
  used: number;
  remaining: number | "unlimited";
  periodStart: Date;
  periodEnd: Date | null;
};

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

export function effectiveManualEntitlements(input: unknown, monthlyQuota?: unknown): TenantEntitlements {
  const values = normalizePlanEntitlements(input);
  if (monthlyQuota !== null && monthlyQuota !== undefined) {
    if (typeof monthlyQuota !== "number" || !Number.isSafeInteger(monthlyQuota) || monthlyQuota < 1) throw new TenantEntitlementConfigError(PRINT_QUOTA_ENTITLEMENT);
    values.max_prints_per_period = monthlyQuota;
  }
  return values;
}

export class TenantEntitlementConfigError extends Error {
  readonly code = "TENANT_ENTITLEMENT_UNAVAILABLE" as const;
  constructor(public readonly entitlement: string) {
    super(`Tenant entitlement ${entitlement} is unavailable`);
  }
}

type EntitlementTx = { execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }> };

export function isTenantBillingError(error: unknown): error is TenantSubscriptionRequiredError | TenantEntitlementConfigError | TenantSuspendedError | TenantDeletedError {
  return error instanceof TenantSubscriptionRequiredError || error instanceof TenantEntitlementConfigError || error instanceof TenantSuspendedError || error instanceof TenantDeletedError;
}

export function liveTenantSubscriptionWhere(tenantId: SQL, requireUnblocked = true): SQL {
  const unblocked = requireUnblocked
    ? sql`AND COALESCE(ts.entitlement_blocked, false) = false`
    : sql``;
  return sql`
    ts.tenant_id = ${tenantId}
    AND EXISTS (
      SELECT 1 FROM tenants entitlement_tenant
      WHERE entitlement_tenant.id = ts.tenant_id
        AND entitlement_tenant.lifecycle = 'active'
    )
    AND ts.status = 'active' AND ts.current_period_start <= clock_timestamp()
    AND ts.current_period_end > clock_timestamp()
    ${unblocked}
  `;
}

export function liveTenantSubscriptionPredicate(tenantId: SQL, requireUnblocked = true): SQL {
  return sql`EXISTS (
    SELECT 1 FROM tenant_subscriptions ts
    WHERE ${liveTenantSubscriptionWhere(tenantId, requireUnblocked)}
  )`;
}

async function lockTenantSubscription(tx: EntitlementTx, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT tenant_id FROM tenant_subscriptions WHERE tenant_id = ${tenantId} FOR UPDATE`);
}

export async function requireTenantBillingAccess(tx: EntitlementTx, tenantId: string): Promise<void> {
  await lockTenantSubscription(tx, tenantId);
  const result = await tx.execute(sql`
    SELECT 1
    FROM tenant_subscriptions ts
    WHERE ${liveTenantSubscriptionWhere(sql`${tenantId}`)}
    LIMIT 1
  `);
  if (result.rows.length === 0) throw new TenantSubscriptionRequiredError();
}

export async function getTenantEntitlementLimit(tx: EntitlementTx, tenantId: string, key: string, lockRows = false): Promise<number | null> {
  if (lockRows) await lockTenantSubscription(tx, tenantId);
  const result = await tx.execute(sql`
    SELECT p.entitlements, ts.monthly_quota AS "monthlyQuota", ts.entitlement_blocked AS "entitlementBlocked"
    FROM tenant_subscriptions ts
    JOIN plans p ON p.id = ts.plan_id
    WHERE ${liveTenantSubscriptionWhere(sql`${tenantId}`, false)}
    LIMIT 1
  `);
  if (!result.rows[0]) throw new TenantSubscriptionRequiredError();
  if (!(PLAN_ENTITLEMENT_KEYS as readonly string[]).includes(key)) throw new TenantEntitlementConfigError(key);
  if (result.rows[0].entitlementBlocked === true) throw new TenantEntitlementConfigError(key);
  let entitlements: TenantEntitlements;
  try {
    entitlements = effectiveManualEntitlements(result.rows[0].entitlements, result.rows[0].monthlyQuota);
  } catch (err) {
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
    SELECT p.entitlements, ts.monthly_quota AS "monthlyQuota", ts.entitlement_blocked AS "entitlementBlocked"
    FROM tenant_subscriptions ts
    JOIN plans p ON p.id = ts.plan_id
    WHERE ${liveTenantSubscriptionWhere(sql`${tenantId}`, false)}
    LIMIT 1
  `);
  if (!result.rows[0]) throw new TenantSubscriptionRequiredError();
  if (result.rows[0].entitlementBlocked === true) throw new TenantEntitlementConfigError("plan_entitlements");
  try {
    return effectiveManualEntitlements(result.rows[0].entitlements, result.rows[0].monthlyQuota);
  } catch (err) {
    logError("entitlements.plan_malformed", {
      tenantId,
      key: "plan_entitlements",
      error: err instanceof Error ? err.message : String(err),
    });
    throw new TenantEntitlementConfigError("plan_entitlements");
  }
}

type TenantPrintQuotaRow = {
  entitlements: unknown;
  periodStart: Date | string;
  periodEnd: Date | string;
  entitlementBlocked?: boolean;
  monthlyQuota?: number | null;
};

export async function getTenantPrintUsage(tx: EntitlementTx, tenantId: string): Promise<TenantPrintUsage> {
  const cycleAt = sql`statement_timestamp() AT TIME ZONE 'UTC'`;
  const result = await tx.execute(sql`
    SELECT p.entitlements, ts.monthly_quota AS "monthlyQuota", ${quotaCycleStartSql(cycleAt)} AS "periodStart", ${quotaCycleEndSql(cycleAt)} AS "periodEnd", ts.entitlement_blocked AS "entitlementBlocked"
    FROM tenant_subscriptions ts
    JOIN plans p ON p.id = ts.plan_id
    WHERE ${liveTenantSubscriptionWhere(sql`${tenantId}`, false)}
    LIMIT 1
  `);
  const row = result.rows[0] as TenantPrintQuotaRow | undefined;
  if (!row) throw new TenantSubscriptionRequiredError();
  if (row.entitlementBlocked === true) throw new TenantEntitlementConfigError(PRINT_QUOTA_ENTITLEMENT);
  let entitlements: TenantEntitlements;
  try {
    entitlements = effectiveManualEntitlements(row.entitlements, row.monthlyQuota);
  } catch (err) {
    logError("entitlements.plan_malformed", { tenantId, key: PRINT_QUOTA_ENTITLEMENT, error: err instanceof Error ? err.message : String(err) });
    throw new TenantEntitlementConfigError(PRINT_QUOTA_ENTITLEMENT);
  }
  const periodStartMs = parseDbTimeMs(row.periodStart);
  const periodEndMs = parseDbTimeMs(row.periodEnd);
  if (periodStartMs === null || periodEndMs === null || periodEndMs <= periodStartMs) {
    throw new TenantEntitlementConfigError("subscription_period");
  }
  const limit = entitlements[PRINT_QUOTA_ENTITLEMENT];
  const used = 0;
  return {
    limit,
    used,
    remaining: limit === "unlimited" ? "unlimited" : Math.max(0, Number(limit) - used),
    periodStart: new Date(periodStartMs),
    periodEnd: new Date(periodEndMs),
  };
}
