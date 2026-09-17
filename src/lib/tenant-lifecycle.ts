import { db } from "../db";
import { tenants, managerSessions } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { writeAuditEvent, type AuditActor } from "./audit";

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
  // deleted is terminal — no outgoing transitions
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
 * Rules:
 *  - active → suspended: blocks all operations, revokes sessions, notifies sockets, records suspendedAt
 *  - suspended → active: restores operations, clears suspendedAt
 *  - active|suspended → deleted: terminal soft-deletion, revokes sessions, notifies sockets, records deletedAt
 *  - deleted is terminal: no transitions out
 *  - current === next is a true no-op
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

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { id: true, lifecycle: true },
  });
  if (!tenant) {
    throw new TenantLifecycleError("Tenant not found", "TENANT_NOT_FOUND", 404);
  }

  const current = tenant.lifecycle as TenantLifecycleState;
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
  await db.transaction(async (tx) => {
    const updates: Record<string, unknown> = {
      lifecycle: next,
      lifecycleReason: reason.trim(),
      updatedAt: now,
    };

    if (next === "suspended") {
      updates.suspendedAt = now;
    } else if (next === "active" && current === "suspended") {
      // Reactivation clears suspension timestamp
      updates.suspendedAt = null;
    } else if (next === "deleted") {
      updates.deletedAt = now;
    }

    await tx.update(tenants).set(updates).where(eq(tenants.id, tenantId));

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
        metadata: { from: current, to: next, reason: reason.trim() },
      },
      tx,
    );
  });

  return { changed: true, lifecycle: next, previousLifecycle: current };
}
