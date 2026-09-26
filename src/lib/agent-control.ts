import { db } from "../db";
import { sql } from "drizzle-orm";
import { agents } from "../db/schema";
import { nanoid } from "./nanoid";
import { generatePairingCode, hashPairingCode } from "./agent-auth";
import { writeAuditEvent } from "./audit";
import { requireManagerPermission } from "./authorization";
import { enforceTenantResourceEntitlement, TenantEntitlementError, isTenantBillingError } from "./entitlements";
import { requireActiveTenantInTransaction } from "./tenant-guard";
import type { ManagerClaims } from "./manager-auth";
import { ActionError } from "./action-error";

/**
 * Control-plane Agent creation shared by HTTP routes and Server Actions.
 *
 * Authentication/authorization is intentionally supplied by the caller's
 * already-validated ManagerClaims. This avoids a trust-boundary mismatch where
 * an HTTP request authenticated via Authorization bearer would be re-read from
 * browser cookies by a Server Action.
 */
export async function createAgentForManager(name: string, manager: ManagerClaims) {
  requireManagerPermission(manager, "agents.pair");
  if (typeof name !== "string" || !name.trim() || name.trim().length > 200) {
    throw new ActionError("Agent name must be 1-200 characters.", 400);
  }

  let pairingCode = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generatePairingCode();
    const clash = await db.query.agents.findFirst({
      where: (row, { eq }) => eq(row.pairingCodeHash, hashPairingCode(candidate)),
      columns: { id: true },
    });
    if (!clash) {
      pairingCode = candidate;
      break;
    }
  }
  if (!pairingCode) throw new ActionError("Could not mint a unique pairing code. Try again.", 500);

  const id = `agt_${nanoid(8)}`;
  let expiresAt: Date | undefined;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agents:' || ${manager.tenantId}))`);
      const clock = await tx.execute(sql`SELECT clock_timestamp() + interval '10 minutes' AS expires_at`);
      const rawExpiresAt = clock.rows[0]?.expires_at;
      const candidate = rawExpiresAt instanceof Date ? rawExpiresAt : new Date(String(rawExpiresAt ?? ""));
      if (!rawExpiresAt || Number.isNaN(candidate.getTime())) throw new Error("Database clock is unavailable");
      expiresAt = candidate;

      await requireActiveTenantInTransaction(tx, manager.tenantId);
      await enforceTenantResourceEntitlement(
        tx,
        manager.tenantId,
        "max_agents",
        sql`SELECT COUNT(*)::int AS count FROM agents WHERE tenant_id = ${manager.tenantId} AND lifecycle <> 'retired'`,
      );
      await tx.insert(agents).values({
        id,
        tenantId: manager.tenantId,
        name: name.trim(),
        pairingCodeHash: hashPairingCode(pairingCode),
        pairingCodeExpiresAt: expiresAt,
        status: "offline",
        lifecycle: "active",
      });
    });
  } catch (error) {
    if (error instanceof TenantEntitlementError) {
      const code = error.entitlement === "max_agents" ? "MAX_AGENTS_EXCEEDED" : "TENANT_ENTITLEMENT_EXCEEDED";
      throw new ActionError(error.message, 429, code, {
        entitlement: error.entitlement,
        limit: error.limit,
        used: error.used,
        upgradeRequired: error.entitlement === "max_agents",
      });
    }
    if (isTenantBillingError(error)) throw new ActionError(error.message, 403, error.code);
    throw error;
  }

  if (!expiresAt) throw new ActionError("Could not create agent pairing expiry.", 500);
  void writeAuditEvent({
    tenantId: manager.tenantId,
    actorType: manager.userId ? "user" : "system",
    actorId: manager.userId ?? "legacy-manager",
    action: "agent.paired",
    resourceType: "agent",
    resourceId: id,
  }).catch(() => undefined);
  return { id, pairingCode, expiresAt, expires_at: expiresAt.toISOString() };
}
