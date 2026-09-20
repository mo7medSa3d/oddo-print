import { sql, type SQL } from "drizzle-orm";
import { logError } from "./log";

export class TenantEntitlementError extends Error {
  readonly code = "TENANT_ENTITLEMENT_EXCEEDED" as const;
  constructor(public readonly entitlement: string, public readonly limit: number) {
    super(`Tenant entitlement ${entitlement} exceeded (limit ${limit})`);
  }
}

export class TenantSubscriptionRequiredError extends Error {
  readonly code = "TENANT_SUBSCRIPTION_REQUIRED" as const;
  constructor() {
    super("An active subscription is required for this operation");
  }
}

export const PLAN_ENTITLEMENT_KEYS = [
  "max_agents",
  "max_printers",
  "max_jobs_per_minute",
  "max_concurrent_jobs",
] as const;

export type PlanEntitlementKey = typeof PLAN_ENTITLEMENT_KEYS[number];
export type EntitlementValue = number | "unlimited";
export type TenantEntitlements = Record<PlanEntitlementKey, EntitlementValue>;

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

export async function getTenantEntitlementLimit(tx: EntitlementTx, tenantId: string, key: string): Promise<number | null> {
  const result = await tx.execute(sql`
    SELECT p.entitlements
    FROM tenant_subscriptions ts
    JOIN plans p ON p.id = ts.plan_id
    WHERE ts.tenant_id = ${tenantId}
      AND ts.status IN ('trialing','active','past_due')
      AND (ts.current_period_end IS NULL OR ts.current_period_end > now())
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
      AND (ts.current_period_end IS NULL OR ts.current_period_end > now())
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

export async function enforceTenantResourceEntitlement(tx: EntitlementTx, tenantId: string, key: string, currentCountSql: SQL): Promise<void> {
  const limit = await getTenantEntitlementLimit(tx, tenantId, key);
  if (limit === null) return;
  const result = await tx.execute(currentCountSql);
  const count = Number(result.rows[0]?.count ?? 0);
  if (count >= limit) throw new TenantEntitlementError(key, limit);
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
    if (count >= minuteLimit) throw new TenantEntitlementError("max_jobs_per_minute", minuteLimit);
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
    if (count >= concurrentLimit) throw new TenantEntitlementError("max_concurrent_jobs", concurrentLimit);
  }
}
