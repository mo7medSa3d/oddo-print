import { sql, and, eq } from "drizzle-orm";
import { db } from "../db";
import { agents, printers } from "../db/schema";
import { canTransitionLifecycle } from "./lifecycle";
import { generatePairingCode, hashPairingCode } from "./agent-auth";

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
 * database boundary instead of relying on a stale pre-check.
 */
export async function transitionAgentLifecycle(
  agentId: string,
  next: "active" | "disabled" | "retired",
  tenantId: string,
): Promise<AgentLifecycleResult | null> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id, lifecycle
      FROM agents
      WHERE id = ${agentId} AND tenant_id = ${tenantId}
      FOR UPDATE
    `);
    const agent = locked.rows[0] as { id?: string; lifecycle?: unknown } | undefined;
    if (!agent?.id) return null;
    if (typeof agent.lifecycle !== "string") throw new Error("agent has an invalid lifecycle value");

    const current = agent.lifecycle as "active" | "disabled" | "retired";
    if (current === next) {
      return { changed: false, lifecycle: next, pairingCode: null };
    }
    if (!canTransitionLifecycle(current, next)) {
      throw new LifecycleConflict(`invalid lifecycle transition: ${current} -> ${next}`);
    }

    const now = new Date();
    const reenable = current === "disabled" && next === "active";
    let pairingCode: string | null = null;

    if (reenable) {
      // Pairing codes are globally resolved before tenant identity is known,
      // so collision checking stays global and uses the same transaction.
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
      updatedAt: now,
    }).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId), eq(agents.lifecycle, current))).returning({ lifecycle: agents.lifecycle });

    if (updated.length !== 1) {
      throw new LifecycleConflict("Agent lifecycle changed concurrently; refresh and try again");
    }

    if (next !== "active") {
      await tx.update(printers).set({ lifecycle: "disabled", updatedAt: now }).where(and(eq(printers.agentId, agentId), eq(printers.tenantId, tenantId)));
    }
    await tx.execute(sql`SELECT pg_notify('print_gateway_agent_sessions', ${JSON.stringify({ agentId })}::text)`);

    return { changed: true, lifecycle: next, pairingCode };
  });
}

export class LifecycleConflict extends Error {}