import { db } from "../db";
import { tenants, managerSessions } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { writeAuditEvent, type AuditActor } from "./audit";
import { runtimeSecret } from "./runtime-secret";

export type TenantLifecycleState = "active" | "suspended" | "deleted";

export class TenantLifecycleError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const ALLOWED_TRANSITIONS: Record<TenantLifecycleState, ReadonlySet<TenantLifecycleState>> = {
  active: new Set(["suspended", "deleted"]),
  suspended: new Set(["active", "deleted"]),
  deleted: new Set(),
};

function canTransitionTenantLifecycle(from: TenantLifecycleState, to: TenantLifecycleState): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

function isTenantLifecycleState(value: unknown): value is TenantLifecycleState {
  return typeof value === "string" && ["active", "suspended", "deleted"].includes(value);
}

export type TransitionTenantLifecycleResult = {
  changed: boolean;
  lifecycle: TenantLifecycleState;
  previousLifecycle: TenantLifecycleState;
};

/**
 * The single authoritative tenant lifecycle transition.
 *
 * The tenant row is locked before reading the current lifecycle. This makes
 * the state check and the authoritative update one serialized transaction,
 * so a stale caller can never overwrite a newer lifecycle transition.
 */
export async function transitionTenantLifecycle(
  tenantId: string,
  next: TenantLifecycleState,
  reason: string,
  actor: { type: AuditActor; id: string | null },
): Promise<TransitionTenantLifecycleResult> {
  if (!isTenantLifecycleState(next)) {
    throw new TenantLifecycleError(`Invalid lifecycle state: ${next}`, "INVALID_LIFECYCLE_STATE", 400);
  }
  if (!reason || reason.trim().length === 0) {
    throw new TenantLifecycleError("Lifecycle transition reason is required", "REASON_REQUIRED", 400);
  }

  const trimmedReason = reason.trim();
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id, lifecycle
      FROM tenants
      WHERE id = ${tenantId}
      FOR UPDATE
    `);
    const tenant = locked.rows[0] as { id?: string; lifecycle?: unknown } | undefined;
    if (!tenant?.id) {
      throw new TenantLifecycleError("Tenant not found", "TENANT_NOT_FOUND", 404);
    }
    const platformTenantId = runtimeSecret("PLATFORM_TENANT_ID")?.trim();
    if (platformTenantId && tenant.id === platformTenantId) {
      throw new TenantLifecycleError(
        "The platform tenant is protected from lifecycle suspension or deletion.",
        "PLATFORM_TENANT_PROTECTED",
        409,
      );
    }
    if (!isTenantLifecycleState(tenant.lifecycle)) {
      throw new TenantLifecycleError("Tenant has an invalid lifecycle value", "INVALID_STORED_LIFECYCLE", 500);
    }

    const current = tenant.lifecycle;
    if (current === next) {
      return { changed: false, lifecycle: current, previousLifecycle: current };
    }

    if (!canTransitionTenantLifecycle(current, next)) {
      throw new TenantLifecycleError(
        `Cannot transition tenant from '${current}' to '${next}'`,
        "INVALID_LIFECYCLE_TRANSITION",
        409,
      );
    }

    const now = new Date();
    const updates: Record<string, unknown> = {
      lifecycle: next,
      lifecycleReason: trimmedReason,
      updatedAt: now,
    };

    if (next === "suspended") {
      updates.suspendedAt = now;
    } else if (next === "active" && current === "suspended") {
      updates.suspendedAt = null;
    } else if (next === "deleted") {
      updates.deletedAt = now;
    }

    const updated = await tx.update(tenants)
      .set(updates)
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id, lifecycle: tenants.lifecycle });
    if (updated.length !== 1) {
      throw new TenantLifecycleError("Tenant lifecycle update lost its target", "LIFECYCLE_CONFLICT", 409);
    }

    if (next === "suspended" || next === "deleted") {
      await tx.delete(managerSessions).where(eq(managerSessions.tenantId, tenantId));
      await tx.execute(sql`SELECT pg_notify('print_gateway_agent_sessions', ${JSON.stringify({ tenantId })})`);
    }

    await writeAuditEvent(
      {
        tenantId,
        actorType: actor.type,
        actorId: actor.id,
        action: `tenant.lifecycle.${next}`,
        resourceType: "tenant",
        resourceId: tenantId,
        metadata: { from: current, to: next, reason: trimmedReason },
      },
      tx,
    );

    return { changed: true, lifecycle: next, previousLifecycle: current };
  });
}