import { db } from "../db";
import { tenants } from "../db/schema";
import { eq } from "drizzle-orm";

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

/**
 * Reusable guard that verifies a tenant is in the 'active' lifecycle state.
 *
 * Throws TenantSuspendedError or TenantDeletedError if the tenant is not
 * active. Returns the lifecycle status on success.
 *
 * This is designed to be called in auth validation paths so all
 * tenant-scoped operations are consistently gated.
 */
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
