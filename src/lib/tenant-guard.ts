import { db } from "../db";
import { tenants } from "../db/schema";
import { eq, sql, type SQL } from "drizzle-orm";

/**
 * Thrown when a tenant is suspended. Maps to HTTP 403.
 */
export class TenantSuspendedError extends Error {
  readonly code = "TENANT_SUSPENDED" as const;
  readonly status = 403;
  constructor(tenantId: string) {
    super(`Workspace is suspended`);
  }
}

/**
 * Thrown when a tenant has been soft-deleted. Maps to HTTP 403.
 */
export class TenantDeletedError extends Error {
  readonly code = "TENANT_DELETED" as const;
  readonly status = 403;
  constructor(tenantId: string) {
    super(`Workspace is no longer available`);
  }
}

export type TenantLifecycleStatus = "active" | "suspended" | "deleted";

export type TenantGuardTx = { execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }> };

/**
 * Transactional tenant lifecycle fence. The shared row lock is the linearization
 * point: a committed suspension/deletion is observed before any protected write;
 * when the runtime transaction gets the lock first, lifecycle transition waits
 * until the write commits. Callers take their existing resource/owner locks
 * first and use this fence immediately before mutation to preserve lock ordering.
 */
export async function requireActiveTenantInTransaction(tx: TenantGuardTx, tenantId: string): Promise<TenantLifecycleStatus> {
  const result = await tx.execute(sql`
    SELECT lifecycle FROM tenants WHERE id = ${tenantId} FOR SHARE
  `);
  const lifecycle = result.rows[0]?.lifecycle;
  if (lifecycle === "suspended") throw new TenantSuspendedError(tenantId);
  if (lifecycle === "deleted" || lifecycle === undefined) throw new TenantDeletedError(tenantId);
  if (lifecycle !== "active") throw new TenantDeletedError(tenantId);
  return "active";
}

/**
 * Reusable guard that verifies a tenant is in the 'active' lifecycle state.
 *
 * Throws TenantSuspendedError or TenantDeletedError if the tenant is not
 * active. Returns the lifecycle status on success.
 *
 * This is designed to be called in auth validation paths so all
 * tenant-scoped operations are consistently gated.
 */
/**
 * Lifecycle-only convenience guard for authentication paths.
 *
 * Expected tenant lifecycle denials become null so callers can preserve their
 * existing authentication return contract. Unexpected database/transport
 * errors are rethrown and must remain visible as operational failures.
 */
export async function requireActiveTenantOrNull(tenantId: string): Promise<TenantLifecycleStatus | null> {
  try {
    return await requireActiveTenant(tenantId);
  } catch (error) {
    if (error instanceof TenantSuspendedError || error instanceof TenantDeletedError) {
      return null;
    }
    throw error;
  }
}

export async function requireActiveTenant(tenantId: string): Promise<TenantLifecycleStatus> {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { lifecycle: true },
  });

  if (!tenant) {
    // Tenant not found is treated as deleted for guard purposes —
    // the caller should have already validated the tenant exists
    // via auth token validation.
    throw new TenantDeletedError(tenantId);
  }

  const lifecycle = tenant.lifecycle as TenantLifecycleStatus;
  if (lifecycle === "suspended") {
    throw new TenantSuspendedError(tenantId);
  }
  if (lifecycle === "deleted") {
    throw new TenantDeletedError(tenantId);
  }

  return lifecycle;
}
