"use server";
import { logError } from "../lib/log";

import { db } from "../db";
import { agents, printers, printJobs, discoverySessions, discoveredDevices } from "../db/schema";
import { eq, count, or, and, inArray, sql, desc } from "drizzle-orm";
import { nanoid } from "../lib/nanoid";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { generatePairingCode, hashPairingCode } from "../lib/agent-auth";
import { getManagerCookieName, verifyManagerToken, validateManagerClaims } from "../lib/manager-auth";
import { createPrintJobForPrinter } from "../lib/print-job-service";
import {
  isTerminal,
  isJobFilterStatus,
  derivePhysicalOutcome,
  PHYSICAL_OUTCOME_UNKNOWN_MARKERS,
  type JobStatus,
} from "../lib/job-status";
import { canTransitionLifecycle } from "../lib/lifecycle";
import { transitionAgentLifecycle, LifecycleConflict } from "../lib/agent-lifecycle";
import { ActionError } from "../lib/action-error";
import { writeAuditEvent } from "../lib/audit";
import { requireManagerPermission } from "../lib/authorization";
import { enforceTenantResourceEntitlement, TenantEntitlementError, TenantPrintQuotaExceededError, isTenantBillingError } from "../lib/entitlements";
import { isAgentAvailableForJob } from "../lib/agent-availability";

async function requireManager() {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) throw new ActionError("Your manager session has expired. Sign in again.", 401);
  return claims;
}

export async function createAgent(name: string) {
  const manager = await requireManager();
  requireManagerPermission(manager, "agents.pair");
  if (typeof name !== "string" || !name.trim() || name.trim().length > 200) throw new ActionError("Agent name must be 1-200 characters.", 400);
  // 0032 guarantees that no two rows share a pending pairing-code hash
  // (the register route looks codes up without a tenant boundary), so
  // regenerate on the astronomically rare collision instead of letting
  // the INSERT violate the constraint and mint an ambiguous code.
  let pairingCode = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generatePairingCode();
    const clash = await db.query.agents.findFirst({
      where: eq(agents.pairingCodeHash, hashPairingCode(candidate)),
      columns: { id: true },
    });
    if (!clash) {
      pairingCode = candidate;
      break;
    }
  }
  if (!pairingCode) throw new ActionError("Could not mint a unique pairing code. Try again.", 500);
  const id = `agt_${nanoid(8)}`;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agents:' || ${manager.tenantId}))`);
      const clock = await tx.execute(sql`SELECT clock_timestamp() + interval '10 minutes' AS expires_at`);
      const expiresAt = clock.rows[0]?.expires_at;
      if (!expiresAt) throw new Error("Database clock is unavailable");

      await enforceTenantResourceEntitlement(
        tx,
        manager.tenantId,
        "max_agents",
        sql`SELECT COUNT(*)::int AS count FROM agents WHERE tenant_id = ${manager.tenantId} AND lifecycle <> 'retired'`,
      );
      await tx.insert(agents).values({
        id, tenantId: manager.tenantId, name: name.trim(),
        pairingCodeHash: hashPairingCode(pairingCode),
        pairingCodeExpiresAt: expiresAt,
        status: "offline", lifecycle: "active",
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
  void writeAuditEvent({ tenantId: manager.tenantId, actorType: manager.userId ? "user" : "system", actorId: manager.userId ?? "legacy-manager", action: "agent.paired", resourceType: "agent", resourceId: id }).catch((err) => logError('audit_write_failed', { error: err?.message ?? String(err) }));
  revalidatePath("/dashboard");
  return { id, pairingCode, expiresAt, expires_at: expiresAt.toISOString() };
}

export async function deleteAgent(id: string) {
  const manager = await requireManager();
  requireManagerPermission(manager, "agents.retire");
  if (typeof id !== "string" || !id.trim()) throw new ActionError("agent id is required", 400);
  const agentId = id.trim();

  await db.transaction(async (tx) => {
    // Acquire row-level lock to prevent concurrent state transitions or reconnect races
    const locked = await tx.execute(sql`
      SELECT id, status, lifecycle, last_seen_at
      FROM agents
      WHERE id = ${agentId} AND tenant_id = ${manager.tenantId}
      FOR UPDATE
    `);
    const agent = (locked as unknown as { rows?: { id: string; status: string; lifecycle: string; last_seen_at?: Date | string | null }[] }).rows?.[0];
    if (!agent) throw new ActionError("Agent not found", 404);
    if (isAgentAvailableForJob({ lifecycle: agent.lifecycle, status: agent.status, lastSeenAt: agent.last_seen_at })) {
      throw new ActionError("This agent is still connected. Stop the agent service first, then delete it.", 409);
    }
    if (agent.lifecycle === "retired") {
      throw new ActionError("Retired agents are kept for audit history and cannot be deleted.", 409);
    }

    // Referential integrity: check if this agent or any of its printers have historical print jobs
    const agentPrinters = await tx.select({ id: printers.id }).from(printers).where(and(eq(printers.agentId, agent.id), eq(printers.tenantId, manager.tenantId)));
    const printerIds = agentPrinters.map((p) => p.id);
    const jobConditions = [and(eq(printJobs.agentId, agent.id), eq(printJobs.tenantId, manager.tenantId))];
    if (printerIds.length > 0) {
      jobConditions.push(and(inArray(printJobs.printerId, printerIds), eq(printJobs.tenantId, manager.tenantId)));
    }
    const [{ c: jobCount }] = await tx
      .select({ c: count() })
      .from(printJobs)
      .where(or(...jobConditions));

    if (Number(jobCount ?? 0) > 0) {
      throw new ActionError("This agent has print history and cannot be deleted. Choose Retire instead to preserve the audit history.", 409);
    }

    // Clean removable transient discovery runtime records
    await tx.delete(discoveredDevices).where(and(eq(discoveredDevices.agentId, agent.id), eq(discoveredDevices.tenantId, manager.tenantId)));
    await tx.delete(discoverySessions).where(and(eq(discoverySessions.agentId, agent.id), eq(discoverySessions.tenantId, manager.tenantId)));

    // Clean removable runtime printers registered by this agent
    await tx.delete(printers).where(and(eq(printers.agentId, agent.id), eq(printers.tenantId, manager.tenantId)));

    // Permanently delete the agent
    await tx.delete(agents).where(and(eq(agents.id, agent.id), eq(agents.tenantId, manager.tenantId)));
    
    // Notify all instances to close any remaining sockets
    await tx.execute(sql`SELECT pg_notify('print_gateway_agent_sessions', ${JSON.stringify({ agentId })}::text)`);
  });

  void writeAuditEvent({ tenantId: manager.tenantId, actorType: manager.userId ? "user" : "system", actorId: manager.userId ?? "legacy-manager", action: "agent.deleted", resourceType: "agent", resourceId: agentId }).catch((err) => logError('audit_write_failed', { error: err?.message ?? String(err) }));
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function createPrintJob(printerId: string, payload: unknown) {
  const manager = await requireManager();
  requireManagerPermission(manager, "jobs.create");
  try {
    const result = await createPrintJobForPrinter(printerId, payload, { requestedBy: "manager", tenantId: manager.tenantId });
    revalidatePath("/dashboard");
    return { id: result.id };
  } catch (error) {
    if (error instanceof TenantPrintQuotaExceededError) throw new ActionError(error.message, 429, error.code, {
      entitlement: error.entitlement,
      limit: error.limit,
      used: error.used,
      remaining: 0,
      periodStart: error.periodStart.toISOString(),
      periodEnd: error.periodEnd?.toISOString() ?? null,
      upgradeRequired: true,
      retryable: false,
    });
    if (error instanceof TenantEntitlementError) throw new ActionError(error.message, 429);
    if (isTenantBillingError(error)) throw new ActionError(error.message, 403);
    throw error;
  }
}

/**
 * Deliberate operator reprint of an ORIGINAL document after a terminal,
 * possibly-printed outcome. This re-queues the job's stored payload — it is
 * NOT a test page. Concurrent requests for the same original job converge
 * on one active reprint inside the Gateway enqueue transaction; once that
 * reprint reaches a terminal state, a later explicit request creates a new
 * reprint sequence. Like Odoo's action_force_reprint, physical reprints of
 * unknown outcomes are always an explicit operator action.
 */
export async function reprintJob(jobId: string) {
  const manager = await requireManager();
  requireManagerPermission(manager, "jobs.retry");
  if (typeof jobId !== "string" || !jobId.trim()) throw new ActionError("job id is required", 400);
  const job = await db.query.printJobs.findFirst({ where: and(eq(printJobs.id, jobId.trim()), eq(printJobs.tenantId, manager.tenantId)) });
  if (!job) throw new ActionError("Job not found", 404);
  if (!isTerminal(job.status as JobStatus)) {
    throw new ActionError("Only finished, failed, or expired jobs can be reprinted. The current job is still in progress.", 409);
  }
  try {
    // Reprint sequence allocation happens inside createPrintJobForPrinter's
    // tenant enqueue transaction, so concurrent double-clicks cannot derive
    // different keys from a stale COUNT(*).
    const result = await createPrintJobForPrinter(job.printerId, job.payload, {
      requestedBy: "manager-reprint",
      reprintOfJobId: job.id,
      destination: job.destination,
      documentType: job.documentType ?? undefined,
      tenantId: manager.tenantId,
    });
    revalidatePath("/dashboard");
    return { id: result.id, reused: result.isReused === true };
  } catch (error) {
    if (error instanceof TenantPrintQuotaExceededError) throw new ActionError(error.message, 429, error.code, {
      entitlement: error.entitlement,
      limit: error.limit,
      used: error.used,
      remaining: 0,
      periodStart: error.periodStart.toISOString(),
      periodEnd: error.periodEnd?.toISOString() ?? null,
      upgradeRequired: true,
      retryable: false,
    });
    if (error instanceof TenantEntitlementError) throw new ActionError(error.message, 429);
    if (isTenantBillingError(error)) throw new ActionError(error.message, 403);
    throw error;
  }
}

export async function setPrinterLifecycle(id: string, lifecycle: "active" | "disabled" | "retired") {
  const manager = await requireManager();
  requireManagerPermission(manager, "printers.manage");

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('printer:' || ${manager.tenantId} || ':' || ${id}))`);

      // Use the same lock ordering as agent heartbeats: agent row first,
      // then printer row. The preliminary lookup does not lock either row;
      // the authoritative printer row is locked only after the owner agent
      // lock is acquired. This prevents an agent heartbeat from deadlocking
      // with a concurrent lifecycle transition.
      const owner = await tx.execute(sql`
        SELECT agent_id
        FROM printers
        WHERE id = ${id} AND tenant_id = ${manager.tenantId}
      `);
      const ownerAgentId = (owner.rows[0] as { agent_id?: string } | undefined)?.agent_id;
      if (!ownerAgentId) throw new ActionError("Printer not found", 404);

      if (lifecycle === "active") {
        const agent = await tx.execute(sql`
          SELECT lifecycle
          FROM agents
          WHERE id = ${ownerAgentId} AND tenant_id = ${manager.tenantId}
          FOR UPDATE
        `);
        const agentLifecycle = (agent.rows[0] as { lifecycle?: string } | undefined)?.lifecycle;
        if (!agentLifecycle) throw new ActionError("The agent that owns this printer no longer exists.", 404);
        if (agentLifecycle !== "active") {
          throw new ActionError(`The agent owning this printer is ${agentLifecycle}; reactivate the agent first.`, 409);
        }
      }

      const locked = await tx.execute(sql`
        SELECT id, agent_id, lifecycle
        FROM printers
        WHERE id = ${id} AND tenant_id = ${manager.tenantId}
        FOR UPDATE
      `);
      const printer = locked.rows[0] as { id?: string; agent_id?: string; lifecycle?: unknown } | undefined;
      if (!printer?.id) throw new ActionError("Printer not found", 404);
      if (typeof printer.lifecycle !== "string") throw new ActionError("Printer has an invalid lifecycle.", 500);

      const current = printer.lifecycle as "active" | "disabled" | "retired";
      if (current === lifecycle) return;

      if (!canTransitionLifecycle(current, lifecycle)) {
        throw new ActionError(`This printer cannot go from ${current} to ${lifecycle}.`, 409);
      }

      const [updated] = await tx.update(printers)
        .set({
          lifecycle,
          managementSource: "manager",
          desiredRevision: sql<number>`${printers.desiredRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(printers.id, id), eq(printers.tenantId, manager.tenantId), eq(printers.lifecycle, current)))
        .returning({ id: printers.id, lifecycle: printers.lifecycle, desiredRevision: printers.desiredRevision });

      if (!updated) throw new ActionError("Printer lifecycle changed concurrently; refresh and try again.", 409);

      await writeAuditEvent({
        tenantId: manager.tenantId,
        actorType: manager.userId ? "user" : "system",
        actorId: manager.userId ?? "legacy-manager",
        action: `printer.lifecycle.${lifecycle}`,
        resourceType: "printer",
        resourceId: id,
        metadata: { from: current, to: lifecycle, desiredRevision: updated.desiredRevision },
      }, tx);
    });
  } catch (error) {
    if (error instanceof ActionError) throw error;
    throw error;
  }

  revalidatePath("/dashboard");
}

export async function setAgentLifecycle(id: string, lifecycle: "active" | "disabled" | "retired") {
  const manager = await requireManager();
  requireManagerPermission(manager, "agents.disable");
  try {
    const result = await transitionAgentLifecycle(id, lifecycle, manager.tenantId, {
      type: manager.userId ? "user" : "system",
      id: manager.userId ?? "legacy-manager",
    });
    if (!result) throw new ActionError("Agent not found", 404);
    // transitionAgentLifecycle persists the single authoritative lifecycle
    // audit event inside the same transaction as the state change.
    revalidatePath("/dashboard");
    return { lifecycle: result.lifecycle, pairingCode: result.pairingCode };
  } catch (error) {
    if (error instanceof LifecycleConflict) throw new ActionError(error.message, 409);
    throw error;
  }
}

export async function getDashboardState() {
  const manager = await requireManager();
  requireManagerPermission(manager, "tenant.read");
  const allAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      pairingCode: sql<string | null>`NULL`,
      pairingCodeExpiresAt: agents.pairingCodeExpiresAt,
      status: agents.status,
      lifecycle: agents.lifecycle,
      metadata: agents.metadata,
      lastSeenAt: agents.lastSeenAt,
      createdAt: agents.createdAt,
      printerCount: count(printers.id),
    })
    .from(agents)
    .leftJoin(printers, and(eq(printers.agentId, agents.id), eq(printers.tenantId, manager.tenantId)))
    .where(eq(agents.tenantId, manager.tenantId))
    .groupBy(agents.id)
    .orderBy(desc(agents.createdAt));

  const allPrinters = await db.select().from(printers).where(eq(printers.tenantId, manager.tenantId)).orderBy(desc(printers.createdAt));
  // Metadata-only projection (same contract as the dashboard page): the
  // 50-row list must not carry multi-MB base64 payload blobs into the
  // browser on every poll; the inspector fetches payloads per job.
  const allJobs = await db
    .select({
      id: printJobs.id,
      tenantId: printJobs.tenantId,
      destination: printJobs.destination,
      documentType: printJobs.documentType,
      agentId: printJobs.agentId,
      printerId: printJobs.printerId,
      status: printJobs.status,
      error: printJobs.error,
      requestedBy: printJobs.requestedBy,
      retries: printJobs.retries,
      deliveryAttempts: printJobs.deliveryAttempts,
      claimedAt: printJobs.claimedAt,
      deliveredAt: printJobs.deliveredAt,
      ackedAt: printJobs.ackedAt,
      expiresAt: printJobs.expiresAt,
      createdAt: printJobs.createdAt,
      updatedAt: printJobs.updatedAt,
    })
    .from(printJobs)
    .where(eq(printJobs.tenantId, manager.tenantId))
    .orderBy(desc(printJobs.createdAt))
    .limit(50);

  const now = new Date();
  const agentsForClient = allAgents.map((agent) => ({ ...agent, status: isAgentAvailableForJob(agent, now) ? "online" : "offline" }));
  return { agents: agentsForClient, printers: allPrinters, jobs: allJobs };
}

export async function getDashboardJobs(options?: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const manager = await requireManager();
  requireManagerPermission(manager, "jobs.read");
  const statusParam = options?.status?.trim().toLowerCase();
  const searchParam = options?.search?.trim();
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const offset = Math.max(options?.offset ?? 0, 0);

  if (statusParam && !isJobFilterStatus(statusParam)) {
    throw new ActionError("Invalid status filter", 400);
  }

  const conditions = [eq(printJobs.tenantId, manager.tenantId)];

  if (statusParam && statusParam !== "all") {
    if (statusParam === "active" || statusParam === "in_flight") {
      conditions.push(inArray(printJobs.status, ["queued", "claimed", "printing"]));
    } else if (statusParam === "queued" || statusParam === "claimed" || statusParam === "printing" || statusParam === "expired") {
      conditions.push(eq(printJobs.status, statusParam));
    } else if (statusParam === "success" || statusParam === "printed") {
      conditions.push(eq(printJobs.status, "success"));
    } else if (statusParam === "unknown" || statusParam === "attention") {
      conditions.push(
        // Non-null: PHYSICAL_OUTCOME_UNKNOWN_MARKERS is a non-empty tuple, so or() always receives >= 1 clause.
        or(...PHYSICAL_OUTCOME_UNKNOWN_MARKERS.map((m) => sql`${printJobs.error} LIKE ${m + "%"}`))!
      );
    } else if (statusParam === "failed") {
      conditions.push(
        // Non-null: and() always receives the fixed eq() clause plus the marker clauses.
        and(
          eq(printJobs.status, "failed"),
          ...PHYSICAL_OUTCOME_UNKNOWN_MARKERS.map((m) => sql`COALESCE(${printJobs.error}, '') NOT LIKE ${m + "%"}`)
        )!
      );
    } else if (statusParam === "unassigned") {
      conditions.push(
        or(eq(printJobs.destination, "unassigned"), eq(printJobs.printerId, "unassigned"), sql`${printJobs.printerId} NOT IN (SELECT id FROM printers WHERE lifecycle = 'active')`, sql`${printJobs.agentId} NOT IN (SELECT id FROM agents WHERE lifecycle = 'active')`)!
      );
    }
  }

  if (searchParam) {
    const term = `%${searchParam.toLowerCase()}%`;
    conditions.push(
      // Non-null: or() always receives six fixed LIKE clauses.
      or(
        sql`LOWER(${printJobs.id}) LIKE ${term}`,
        sql`LOWER(COALESCE(${printJobs.destination}, '')) LIKE ${term}`,
        sql`LOWER(COALESCE(${printJobs.documentType}, '')) LIKE ${term}`,
        sql`LOWER(${printJobs.printerId}) LIKE ${term}`,
        sql`LOWER(${printJobs.agentId}) LIKE ${term}`,
        sql`LOWER(COALESCE(${printJobs.error}, '')) LIKE ${term}`
      )!
    );
  }

  const rows = await db
    .select({
      id: printJobs.id,
      destination: printJobs.destination,
      documentType: printJobs.documentType,
      agentId: printJobs.agentId,
      printerId: printJobs.printerId,
      status: printJobs.status,
      error: printJobs.error,
      requestedBy: printJobs.requestedBy,
      retries: printJobs.retries,
      deliveryAttempts: printJobs.deliveryAttempts,
      claimedAt: printJobs.claimedAt,
      deliveredAt: printJobs.deliveredAt,
      ackedAt: printJobs.ackedAt,
      expiresAt: printJobs.expiresAt,
      createdAt: printJobs.createdAt,
      updatedAt: printJobs.updatedAt,
    })
    .from(printJobs)
    .where(conditions.length ? and(...conditions)! : undefined)
    .orderBy(desc(printJobs.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => ({
    ...row,
    physicalOutcome: derivePhysicalOutcome(row.status, row.error),
  }));
}


