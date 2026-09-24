import { sql, and, eq } from "drizzle-orm";
import { db } from "../db";
import { agents } from "../db/schema";
import { canTransitionLifecycle } from "./lifecycle";
import { generatePairingCode, hashPairingCode } from "./agent-auth";
import { writeAuditEvent, type AuditActor } from "./audit";
import { requireTenantBillingAccess } from "./entitlements";

export type AgentLifecycleResult = {
  changed: boolean;
  lifecycle: string;
  pairingCode: string | null;
};

/**
 * The single authoritative agent lifecycle transition.
 *
 * The agent row is locked before reading its lifecycle. Claim paths lock the
 * same agent row, so lifecycle changes and job claims serialize at the
 * database boundary instead of relying on a stale pre-check. Audit persistence
 * is part of the same transaction as the lifecycle mutation.
 */
export async function transitionAgentLifecycle(
  agentId: string,
  next: "active" | "disabled" | "retired",
  tenantId: string,
  actor: { type: AuditActor; id: string | null },
): Promise<AgentLifecycleResult | null> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id, lifecycle, lifecycle_revision
      FROM agents
      WHERE id = ${agentId} AND tenant_id = ${tenantId}
      FOR UPDATE
    `);
    const agent = locked.rows[0] as { id?: string; lifecycle?: unknown; lifecycle_revision?: unknown } | undefined;
    if (!agent?.id) return null;
    if (typeof agent.lifecycle !== "string") throw new Error("agent has an invalid lifecycle value");
    const currentRevision = Number(agent.lifecycle_revision ?? 0);
    if (!Number.isInteger(currentRevision) || currentRevision < 0) {
      throw new Error("agent has an invalid lifecycle revision");
    }

    const current = agent.lifecycle as "active" | "disabled" | "retired";
    const clock = await tx.execute(sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms`);
    const nowMs = Number(clock.rows[0]?.now_ms);
    if (!Number.isFinite(nowMs)) throw new Error("Database clock is unavailable");
    const now = new Date(nowMs);
    if (current === next) {
      return { changed: false, lifecycle: next, pairingCode: null };
    }
    if (!canTransitionLifecycle(current, next)) {
      throw new LifecycleConflict(`invalid lifecycle transition: ${current} -> ${next}`);
    }

    const reenable = current === "disabled" && next === "active";
    let pairingCode: string | null = null;

    if (reenable) {
      await requireTenantBillingAccess(tx, tenantId);
    }

    if (reenable) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = generatePairingCode();
        const clash = await tx.query.agents.findFirst({
          where: eq(agents.pairingCodeHash, hashPairingCode(candidate)),
          columns: { id: true },
        });
        if (!clash || clash.id === agentId) {
          pairingCode = candidate;
          break;
        }
      }
      if (!pairingCode) throw new Error("could not mint a unique pairing code");
    }

    const updated = await tx.update(agents).set({
      lifecycle: next,
      secret: null,
      pairingCodeHash: pairingCode ? hashPairingCode(pairingCode) : null,
      pairingCodeExpiresAt: pairingCode ? new Date(now.getTime() + 10 * 60 * 1000) : null,
      status: "offline",
      lifecycleRevision: currentRevision + 1,
      updatedAt: now,
    }).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId), eq(agents.lifecycle, current), eq(agents.lifecycleRevision, currentRevision))).returning({
      lifecycle: agents.lifecycle,
      lifecycleRevision: agents.lifecycleRevision,
    });

    if (updated.length !== 1) {
      throw new LifecycleConflict("Agent lifecycle changed concurrently; refresh and try again");
    }

    await writeAuditEvent(
      {
        tenantId,
        actorType: actor.type,
        actorId: actor.id,
        action: `agent.lifecycle.${next}`,
        resourceType: "agent",
        resourceId: agentId,
        metadata: { from: current, to: next },
      },
      tx,
    );
    const nextRevision = Number(updated[0]?.lifecycleRevision);
    if (!Number.isInteger(nextRevision) || nextRevision <= currentRevision) {
      throw new Error("agent lifecycle revision did not advance");
    }
    await tx.execute(sql`SELECT pg_notify('print_gateway_agent_sessions', ${JSON.stringify({ agentId, lifecycleRevision: nextRevision })}::text)`);

    return { changed: true, lifecycle: next, pairingCode };
  });
}

export class LifecycleConflict extends Error {}