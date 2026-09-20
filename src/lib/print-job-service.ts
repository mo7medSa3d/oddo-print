import { agents, printJobs, printers } from "../db/schema";
import { db } from "../db";
import { isVirtualPrinterRecord } from "./printer-virtual";
import { isPrinterStatusExecutable, validatePayloadForPrinter } from "./routing";
import { validatePrintJobPayload } from "./payload";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "./nanoid";
import { canonicalize } from "./canonicalize";
import { MAX_AGENT_IN_FLIGHT_JOBS } from "./job-delivery";

import { enforceTenantJobEntitlements } from "./entitlements";
import { logInfo } from "./log";

export const MAX_AGENT_QUEUED_JOBS = 256;
export const MAX_AGENT_QUEUED_PAYLOAD_BYTES = 128 * 1024 * 1024;

/**
 * Queue admission intentionally does not require a fresh Agent heartbeat.
 * Gateway jobs are durable until their expiry, so an active but temporarily
 * offline Agent remains a valid owner. Heartbeat freshness is enforced when
 * claiming/executing the job, not when the job is created.
 */

export class AgentQueueFullError extends Error {
  readonly code = "AGENT_QUEUE_FULL" as const;
  constructor(public readonly agentId: string, public readonly inFlight: number) {
    super(`Agent ${agentId} has reached the maximum of ${MAX_AGENT_IN_FLIGHT_JOBS} in-flight jobs`);
  }
}
export class AgentQueuedJobsFullError extends Error {
  readonly code = "AGENT_QUEUED_QUEUE_FULL" as const;
  constructor(public readonly agentId: string, public readonly queued: number) {
    super(`Agent ${agentId} has reached the maximum of ${MAX_AGENT_QUEUED_JOBS} queued jobs`);
  }
}
export class PrintJobCapabilityError extends Error {
  readonly code = "CAPABILITY_MISMATCH" as const;
  constructor(reason: string) {
    super(reason);
  }
}

/**
 * Expected, operator-safe input/state failures. Routes map these to explicit
 * HTTP statuses; anything NOT of this family is an internal error and must be
 * logged, never echoed to clients.
 */
export class PrintJobInputError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function idempotencyFingerprint(input: {
  printerId: string;
  documentType?: string | null;
  destination?: string | null;
  payload: unknown;
}) {
  return JSON.stringify({
    printerId: input.printerId,
    documentType: input.documentType?.trim().toLowerCase() || null,
    destination: input.destination?.trim() || null,
    payload: canonicalize(input.payload),
  });
}

export type CreatePrintJobOptions = {
  requestedBy: string;
  idempotencyKey?: string | null;
  tenantId: string;
  destination?: string | null;
  documentType?: string | null;
  expiresAt?: Date;
  rateLimitKeyId?: string | null;
  requestId?: string | null;
  /** Generate a serialized operator reprint key for this original job inside the enqueue transaction. */
  reprintOfJobId?: string | null;
};

export type CreatePrintJobResult = {
  id: string;
  printerId: string;
  agentId: string;
  status: string;
  isReused?: boolean;
};

function normalizeRequestedBy(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) throw new PrintJobInputError("requestedBy is invalid", "INVALID_REQUEST", 400);
  return normalized;
}

async function insertQueuedJobAtomically({
  jobId, printerId, agentId, tenantId, validatedPayload, expiresAt, requestedBy,
  idempotencyKey, destination, documentType, rateLimitKeyId, requestId, reprintOfJobId,
}: {
  jobId: string;
  printerId: string;
  agentId: string;
  tenantId: string;
  validatedPayload: ReturnType<typeof validatePrintJobPayload>;
  expiresAt: Date;
  requestedBy: string;
  idempotencyKey?: string | null;
  destination?: string | null;
  documentType?: string | null;
  rateLimitKeyId?: string | null;
  requestId?: string | null;
  reprintOfJobId?: string | null;
}): Promise<{ jobId: string; status: string; agentId: string; printerId: string; isReused: boolean }> {
  if (!tenantId || tenantId.length > 128) throw new PrintJobInputError("tenantId is invalid", "INVALID_TENANT", 400);

  return await db.transaction(async (tx) => {
    // Serialize admission per tenant so max_jobs_per_minute and
    // max_concurrent_jobs cannot be exceeded by racing requests.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:tenant:${tenantId}`}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agentId}`}))`);

    // Reprint coordination happens only after the tenant enqueue lock is
    // held. While an earlier reprint of the same original job is still active,
    // concurrent operator requests converge on that existing job instead of
    // creating a second physical print. Once it is terminal, a new sequence is
    // intentionally allocated for the next explicit reprint.
    let effectiveIdempotencyKey = idempotencyKey ?? null;
    if (reprintOfJobId) {
      const activeReprint = await tx.execute(sql`
        SELECT id, printer_id, agent_id, status
        FROM print_jobs
        WHERE tenant_id = ${tenantId}
          AND idempotency_key LIKE ${`gw-reprint:${reprintOfJobId}:%`}
          AND status IN ('queued', 'claimed', 'printing')
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `);
      if (activeReprint.rows.length > 0) {
        const row = activeReprint.rows[0] as { id: string; printer_id: string; agent_id: string; status: string };
        return { jobId: row.id, status: row.status, agentId: row.agent_id, printerId: row.printer_id, isReused: true };
      }

      const countResult = await tx.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM print_jobs
        WHERE tenant_id = ${tenantId}
          AND idempotency_key LIKE ${`gw-reprint:${reprintOfJobId}:%`}
      `);
      const count = Number((countResult.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
      effectiveIdempotencyKey = `gw-reprint:${reprintOfJobId}:${count + 1}`;
    }

    if (effectiveIdempotencyKey) {
      const lockKey = `print_jobs:idempotency:${tenantId}:${effectiveIdempotencyKey}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    }

    if (effectiveIdempotencyKey) {
      const existing = await tx.execute(sql`SELECT id, printer_id, destination, document_type, payload, agent_id, status FROM print_jobs WHERE tenant_id = ${tenantId} AND idempotency_key = ${effectiveIdempotencyKey} LIMIT 1 FOR UPDATE`);
      if (existing.rows.length > 0) {
        const row = existing.rows[0] as {
          id: string;
          printer_id: string;
          destination?: string | null;
          document_type?: string | null;
          payload: unknown;
          agent_id: string;
          status: string;
        };
        const storedFingerprint = idempotencyFingerprint({
          printerId: row.printer_id,
          documentType: row.document_type,
          destination: row.destination,
          payload: row.payload,
        });
        const requestFingerprint = idempotencyFingerprint({
          printerId,
          documentType,
          destination,
          payload: validatedPayload,
        });

        if (storedFingerprint === requestFingerprint) {
          return {
            jobId: row.id,
            status: row.status,
            agentId: row.agent_id,
            printerId: row.printer_id,
            isReused: true,
          };
        }
        const conflictErr = new Error("IDEMPOTENCY_CONFLICT");
        Object.assign(conflictErr, { code: "IDEMPOTENCY_CONFLICT" });
        throw conflictErr;
      }
    }

    // Re-validate the runtime owner INSIDE the enqueue transaction.
    // The initial pre-check in createPrintJobForPrinter intentionally happens
    // before payload validation, but printer/agent lifecycle and health can
    // change between that read and this INSERT. Without this second boundary
    // the Gateway could persist a queued job against a retired/offline printer
    // or a stale agent, leaving an apparently accepted job that can never be
    // claimed. Lock order (agent -> printer) matches the manager printer PATCH
    // path's row-lock order to avoid an enqueue-vs-reconfigure deadlock.
    const runtimeOwner = await tx.execute(sql`
      SELECT
        p.lifecycle AS printer_lifecycle,
        p.status AS printer_status,
        p.connection_type AS printer_connection_type,
        p.protocol AS printer_protocol,
        p.agent_id AS printer_agent_id,
        p.management_source AS management_source,
        p.capabilities AS printer_capabilities,
        p.applied_desired_revision AS applied_desired_revision,
        p.desired_revision AS desired_revision,
        a.lifecycle AS agent_lifecycle,
        a.status AS agent_status,
        a.last_seen_at AS agent_last_seen_at
      FROM agents a
      JOIN printers p
        ON p.agent_id = a.id
       AND p.tenant_id = a.tenant_id
      WHERE a.id = ${agentId}
        AND a.tenant_id = ${tenantId}
        AND p.id = ${printerId}
        AND p.tenant_id = ${tenantId}
      FOR UPDATE OF a, p
    `);
    const owner = runtimeOwner.rows[0] as {
      printer_lifecycle?: string;
      printer_status?: string;
      printer_connection_type?: string;
      printer_protocol?: string;
      printer_agent_id?: string;
      management_source?: string;
      printer_capabilities?: { supported_protocols?: string[] } | null;
      applied_desired_revision?: number | string;
      desired_revision?: number | string;
      agent_lifecycle?: string;
      agent_status?: string;
      agent_last_seen_at?: Date | string | null;
    } | undefined;
    if (!owner || owner.printer_agent_id !== agentId) {
      throw new PrintJobInputError("Printer owner changed during enqueue; retry the print operation", "PRINTER_OWNER_CHANGED", 409);
    }
    if (owner.printer_lifecycle !== "active") {
      throw new PrintJobInputError(`Printer is ${owner.printer_lifecycle ?? "unavailable"}`, "PRINTER_UNAVAILABLE", 409);
    }
    if (!isPrinterStatusExecutable({
      status: owner.printer_status ?? null,
      connectionType: owner.printer_connection_type ?? null,
      protocol: owner.printer_protocol ?? null,
    })) {
      throw new PrintJobInputError("Printer is not executable", "PRINTER_OFFLINE", 503);
    }
    if (owner.agent_lifecycle !== "active") {
      throw new PrintJobInputError(`Agent is ${owner.agent_lifecycle ?? "unavailable"}`, "AGENT_UNAVAILABLE", 409);
    }
    // The Gateway queue is durable. An active Agent may be temporarily
    // offline/stale and should still be allowed to receive a queued job; the
    // Agent will claim it after reconnecting. Lifecycle remains the hard
    // control-plane fence, while heartbeat freshness is execution availability,
    // not admission eligibility.
    if (
      owner.management_source === "manager" &&
      Number(owner.applied_desired_revision ?? 0) < Number(owner.desired_revision ?? 0)
    ) {
      throw new PrintJobInputError("Printer configuration is still applying; retry when the printer is ready", "PRINTER_UNAVAILABLE", 503);
    }

    // Capability validation is repeated under the authoritative printer row
    // lock. The pre-check in createPrintJobForPrinter can race with a manager
    // PATCH that changes protocol/connection/capabilities between the initial
    // read and INSERT; without this second check, a payload accepted for the
    // old capability set could be durably queued against the new one.
    const runtimeCapability = validatePayloadForPrinter(validatedPayload, {
      protocol: owner.printer_protocol,
      connectionType: owner.printer_connection_type,
      capabilities: owner.printer_capabilities,
    });
    if (!runtimeCapability.ok) {
      throw new PrintJobCapabilityError(runtimeCapability.reason);
    }

    await enforceTenantJobEntitlements(tx, tenantId);

    const counts = await tx.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE agent_id = ${agentId} AND status = 'queued' AND expires_at > now())::int AS agent_queued,
        COALESCE(SUM(pg_column_size(payload)) FILTER (WHERE agent_id = ${agentId} AND status = 'queued' AND expires_at > now()), 0)::bigint AS agent_queued_payload_bytes,
        COUNT(*) FILTER (WHERE agent_id = ${agentId} AND status IN ('claimed', 'printing') AND expires_at > now())::int AS agent_in_flight
      FROM print_jobs WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
    `);
    const row = counts.rows[0] as {
      agent_queued?: number | string;
      agent_queued_payload_bytes?: number | string;
      agent_in_flight?: number | string;
    } | undefined;
    const agentQueued = Number(row?.agent_queued ?? 0);
    const queuedPayloadBytes = Number(row?.agent_queued_payload_bytes ?? 0);
    const inFlight = Number(row?.agent_in_flight ?? 0);
    if (agentQueued >= MAX_AGENT_QUEUED_JOBS || queuedPayloadBytes + Buffer.byteLength(JSON.stringify(validatedPayload), "utf8") >= MAX_AGENT_QUEUED_PAYLOAD_BYTES) {
      throw new AgentQueuedJobsFullError(agentId, agentQueued);
    }
    if (inFlight >= MAX_AGENT_IN_FLIGHT_JOBS) throw new AgentQueueFullError(agentId, inFlight);

    await tx.insert(printJobs).values({
      id: jobId,
      tenantId,
      apiKeyId: rateLimitKeyId ?? null,
      destination: destination ?? null,
      documentType: documentType ?? null,
      agentId,
      printerId,
      status: "queued",
      payload: validatedPayload,
      requestedBy,
      requestId: requestId ?? null,
      idempotencyKey: effectiveIdempotencyKey,
      expiresAt,
    });

    await tx.execute(sql`SELECT pg_notify('print_gateway_agent_jobs', ${JSON.stringify({ jobId, agentId, requestId: requestId ?? null })})`);

    return {
      jobId,
      status: "queued",
      agentId,
      printerId,
      isReused: false,
    };
  });
}

export async function createPrintJobForPrinter(
  printerId: string,
  payload: unknown,
  options: CreatePrintJobOptions,
): Promise<CreatePrintJobResult> {
  const normalizedPrinterId = typeof printerId === "string" ? printerId.trim() : "";
  if (!normalizedPrinterId) throw new PrintJobInputError("printer id is required", "INVALID_REQUEST", 400);
  const requestedBy = normalizeRequestedBy(options.requestedBy);
  const printer = await db.query.printers.findFirst({ where: and(eq(printers.id, normalizedPrinterId), eq(printers.tenantId, options.tenantId)) });
  if (!printer) throw new PrintJobInputError("Printer not found", "PRINTER_NOT_FOUND", 404);
  if (printer.lifecycle !== "active") throw new PrintJobInputError(`Printer is ${printer.lifecycle}`, "PRINTER_UNAVAILABLE", 409);
  if (isVirtualPrinterRecord(printer)) throw new PrintJobInputError("Printer is virtual or redirected", "PRINTER_VIRTUAL", 409);
  if (!isPrinterStatusExecutable(printer)) throw new PrintJobInputError("Printer is not executable", "PRINTER_OFFLINE", 503);

  const validatedPayload = validatePrintJobPayload(payload);
  const capability = validatePayloadForPrinter(validatedPayload, {
    protocol: printer.protocol, connectionType: printer.connectionType, capabilities: printer.capabilities,
  });
  if (!capability.ok) throw new PrintJobCapabilityError(capability.reason);

  const ownerAgent = await db.query.agents.findFirst({ where: and(eq(agents.id, printer.agentId), eq(agents.tenantId, options.tenantId)) });
  if (!ownerAgent) throw new PrintJobInputError("Printer owner agent not found", "AGENT_NOT_FOUND", 404);
  if (ownerAgent.lifecycle !== "active") throw new PrintJobInputError(`Agent is ${ownerAgent.lifecycle}`, "AGENT_UNAVAILABLE", 409);

  if (typeof options.tenantId !== "string" || !options.tenantId.trim()) throw new PrintJobInputError("tenant context is required", "TENANT_CONTEXT_REQUIRED", 500);

  const id = `job_${nanoid(12)}`;
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000);
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new PrintJobInputError("expiresAt must be in the future", "INVALID_REQUEST", 400);
  }

  const enqueueStartedAt = Date.now();
  const result = await insertQueuedJobAtomically({
    jobId: id,
    printerId: printer.id,
    agentId: ownerAgent.id,
    validatedPayload,
    expiresAt,
    requestedBy,
    idempotencyKey: options.idempotencyKey ?? null,
    destination: options.destination ?? null,
    documentType: options.documentType ?? null,
    rateLimitKeyId: options.rateLimitKeyId ?? null,
    requestId: options.requestId ?? null,
    reprintOfJobId: options.reprintOfJobId ?? null,
    tenantId: options.tenantId,
  });
  logInfo("print.trace.gateway_enqueue", {
    requestId: options.requestId ?? null,
    jobId: result.jobId,
    agentId: result.agentId,
    printerId: result.printerId,
    enqueueLatencyMs: Date.now() - enqueueStartedAt,
    reused: result.isReused,
  });

  if (result.isReused) {
    return { id: result.jobId, printerId: result.printerId, agentId: result.agentId, status: result.status, isReused: true };
  }

  return { id: result.jobId, printerId: printer.id, agentId: ownerAgent.id, status: "queued", isReused: false };
}
