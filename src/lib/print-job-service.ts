import { createHash } from "node:crypto";
import { agents, printJobs, printers, printJobReceipts } from "../db/schema";
import { db } from "../db";
import { isVirtualPrinterRecord, isVirtualCaptureTestRecord, isApprovedVirtualSpoolerTestRecord } from "./printer-virtual";
import { isPrinterStatusExecutable, validatePayloadForPrinter } from "./routing";
import { validatePrintJobPayload } from "./payload";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "./nanoid";
import { canonicalize } from "./canonicalize";
import { MAX_AGENT_IN_FLIGHT_JOBS } from "./job-delivery";

import { enforceTenantJobEntitlements, reserveTenantPrintCredit } from "./entitlements";
import { logInfo, logWarn } from "./log";
import { recordJobEvent } from "./job-timeline";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "./manager-mutation-authorization";
import type { ManagerClaims } from "./manager-auth";
import type { ManagerPermission } from "./authorization";

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

export function idempotencyDigest(input: Parameters<typeof idempotencyFingerprint>[0]): string {
  return createHash("sha256").update(idempotencyFingerprint(input)).digest("hex");
}

export type CreatePrintJobOptions = {
  /** Manager-authenticated jobs require a live commit-point authority fence;
   * API key jobs must not fake a Manager principal. */
  managerAuthority?: { claims: ManagerClaims; permission: ManagerPermission };
  requestedBy: string;
  idempotencyKey?: string | null;
  tenantId: string;
  destination?: string | null;
  documentType?: string | null;
  expiresAt?: Date;
  rateLimitKeyId?: string | null;
  requestId?: string | null;
  /** Only the RBAC-protected Manager test-print route may authorize a virtual file capture. */
  allowVirtualTestCapture?: boolean;
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
  idempotencyKey, destination, documentType, rateLimitKeyId, requestId, reprintOfJobId, allowVirtualTestCapture, managerAuthority,
}: {
  jobId: string;
  printerId: string;
  agentId: string;
  tenantId: string;
  validatedPayload: ReturnType<typeof validatePrintJobPayload>;
  expiresAt?: Date;
  requestedBy: string;
  idempotencyKey?: string | null;
  destination?: string | null;
  documentType?: string | null;
  rateLimitKeyId?: string | null;
  requestId?: string | null;
  reprintOfJobId?: string | null;
  allowVirtualTestCapture?: boolean;
  managerAuthority?: { claims: ManagerClaims; permission: ManagerPermission };
}): Promise<{ jobId: string; status: string; agentId: string; printerId: string; isReused: boolean }> {
  if (!tenantId || tenantId.length > 128) throw new PrintJobInputError("tenantId is invalid", "INVALID_TENANT", 400);

  return await db.transaction(async (tx) => {
    // PostgreSQL is the authoritative clock for print-job lifetime.
    const clockResult = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    const clockRows = (clockResult as unknown as { rows?: Array<{ now?: Date | string }> }).rows ?? [];
    const rawNow = clockRows[0]?.now;
    const dbNow = rawNow instanceof Date
      ? rawNow
      : new Date(typeof rawNow === "string"
        ? rawNow.trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")
        : "");
    if (Number.isNaN(dbNow.getTime())) {
      throw new PrintJobInputError("Database clock is unavailable", "INTERNAL_ERROR", 500);
    }
    const effectiveExpiresAt = expiresAt ?? new Date(dbNow.getTime() + 60 * 60 * 1000);


    // Serialize admission per tenant so max_jobs_per_minute and
    // max_concurrent_jobs cannot be exceeded by racing requests.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:tenant:${tenantId}`}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agentId}`}))`);

    if (managerAuthority) {
      // Identity reuse can disclose a job ID and requestedBy even without a
      // new insert. Fence the live principal BEFORE all idempotency/reprint
      // reuse paths. Preserve Agent -> Tenant -> Actor -> session lock order.
      if (managerAuthority.claims.tenantId !== tenantId) {
        throw new PrintJobInputError("Workspace session does not own this job", "MANAGER_TENANT_MISMATCH", 403);
      }
      const guardedAgent = await tx.execute(sql`
        SELECT id FROM agents WHERE id = ${agentId} AND tenant_id = ${tenantId} FOR UPDATE
      `);
      if (!guardedAgent.rows.length) throw new PrintJobInputError("Agent no longer exists", "AGENT_NOT_FOUND", 404);
      const guardedTenant = await tx.execute(sql`
        SELECT lifecycle FROM tenants WHERE id = ${tenantId} FOR UPDATE
      `);
      if ((guardedTenant.rows[0] as { lifecycle?: string } | undefined)?.lifecycle !== "active") {
        throw new PrintJobInputError("Workspace is no longer active", "TENANT_UNAVAILABLE", 403);
      }
      try {
        await requireManagerActorInTransaction(tx, managerAuthority.claims, managerAuthority.permission);
      } catch (error) {
        if (error instanceof ManagerMutationAuthorityChangedError) {
          throw new PrintJobInputError(error.message, "MANAGER_AUTH_CHANGED", 403);
        }
        throw error;
      }
    }

    // Reprint coordination happens only after the tenant enqueue lock is
    // held. While an earlier reprint of the same original job is still active,
    // concurrent operator requests converge on that existing job instead of
    // creating a second physical print. Once it is terminal, a new sequence is
    // intentionally allocated for the next explicit reprint.
    let effectiveIdempotencyKey = idempotencyKey ?? null;
    if (reprintOfJobId) {
      // Escape LIKE wildcards in reprintOfJobId. Job IDs use the format
      // `job_XXXX` — the underscore (`_`) is a SQL LIKE wildcard matching any
      // single character. Without escaping, `LIKE 'gw-reprint:job_ABC:%'` would
      // also match `gw-reprint:jobXABC:%`. Escaping with backslash and adding
      // ESCAPE '\\' makes the pattern exact.
      const escapedReprintId = reprintOfJobId.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const activeReprint = await tx.execute(sql`
        SELECT id, printer_id, agent_id, status
        FROM print_jobs
        WHERE tenant_id = ${tenantId}
          AND idempotency_key LIKE ${`gw-reprint:${escapedReprintId}:%`} ESCAPE '\\'
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
        FROM (SELECT tenant_id, idempotency_key FROM print_jobs
              UNION ALL SELECT tenant_id, idempotency_key FROM print_job_receipts) history
        WHERE tenant_id = ${tenantId}
          AND idempotency_key LIKE ${`gw-reprint:${escapedReprintId}:%`} ESCAPE '\\'
      `);
      const count = Number((countResult.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
      effectiveIdempotencyKey = `gw-reprint:${reprintOfJobId}:${count + 1}`;
    }

    if (effectiveIdempotencyKey) {
      const lockKey = `print_jobs:idempotency:${tenantId}:${effectiveIdempotencyKey}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    }

    if (effectiveIdempotencyKey) {
      const receipt = await tx.query.printJobReceipts.findFirst({ where: and(eq(printJobReceipts.tenantId, tenantId), eq(printJobReceipts.idempotencyKey, effectiveIdempotencyKey)) });
      if (receipt) {
        if ((rateLimitKeyId && receipt.apiKeyId === null) ||
            (managerAuthority && receipt.requestedBy !== requestedBy) ||
            receipt.fingerprint !== idempotencyDigest({ printerId, documentType, destination, payload: validatedPayload })) {
          throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), { code: "IDEMPOTENCY_CONFLICT" });
        }
        return { jobId: receipt.id, status: receipt.status, agentId: receipt.agentId, printerId: receipt.printerId, isReused: true };
      }
      const existing = await tx.execute(sql`SELECT id, printer_id, destination, document_type, payload, agent_id, status, api_key_id, requested_by FROM print_jobs WHERE tenant_id = ${tenantId} AND idempotency_key = ${effectiveIdempotencyKey} LIMIT 1 FOR UPDATE`);
      if (existing.rows.length > 0) {
        const row = existing.rows[0] as {
          id: string;
          printer_id: string;
          destination?: string | null;
          document_type?: string | null;
          payload: unknown;
          agent_id: string;
          status: string;
          api_key_id: string | null;
          requested_by: string | null;
        };
        // Odoo status APIs intentionally exclude internal Manager jobs. The
        // same boundary must apply to Odoo idempotency: never return an
        // internal job identity to an Odoo caller. Because the database uses a
        // tenant-wide idempotency uniqueness constraint, a collision with an
        // internal key is a deterministic conflict, not a reusable Odoo job.
        if ((rateLimitKeyId && row.api_key_id === null) ||
            (managerAuthority && row.requested_by !== requestedBy)) {
          const conflictErr = new Error("IDEMPOTENCY_CONFLICT");
          Object.assign(conflictErr, { code: "IDEMPOTENCY_CONFLICT" });
          throw conflictErr;
        }
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

    if (!(effectiveExpiresAt instanceof Date) || Number.isNaN(effectiveExpiresAt.getTime()) || effectiveExpiresAt.getTime() <= dbNow.getTime()) {
      throw new PrintJobInputError("expiresAt must be in the future", "INVALID_REQUEST", 400);
    }
    if (effectiveExpiresAt.getTime() - dbNow.getTime() > 24 * 60 * 60 * 1000) {
      throw new PrintJobInputError("expiresAt exceeds the 24 hour maximum", "INVALID_REQUEST", 400);
    }

    // Re-validate the runtime owner INSIDE the enqueue transaction.
    // Idempotency reuse above precedes mutable runtime eligibility.
    // Printer/agent lifecycle and health can
    // change between that read and this INSERT. Without this second boundary
    // the Gateway could persist a queued job against a retired/offline printer
    // or a stale agent, leaving an apparently accepted job that can never be
    // claimed. Lock order (agent -> printer) matches the manager printer PATCH
    // path's row-lock order to avoid an enqueue-vs-reconfigure deadlock.
    //
    // NOTE: The tenants table is also joined here (not in the original query)
    // and its row is locked with the Agent and Printer. This closes the TOCTOU
    // window against a concurrent tenant suspend/delete: the lifecycle read and
    // the INSERT are now linearized with the authoritative tenant transition.
    // The poll-claim path already guards on t.lifecycle; this makes enqueue
    // admission equally strict.
    const runtimeOwner = await tx.execute(sql`
      SELECT
        p.name AS printer_name,
        p.printer_type AS printer_type,
        p.device_class AS printer_device_class,
        p.lifecycle AS printer_lifecycle,
        p.status AS printer_status,
        p.inventory_present AS printer_inventory_present,
        p.connection_type AS printer_connection_type,
        p.protocol AS printer_protocol,
        p.agent_id AS printer_agent_id,
        p.management_source AS management_source,
        p.capabilities AS printer_capabilities,
        p.config AS printer_config,
        p.applied_desired_revision AS applied_desired_revision,
        p.desired_revision AS desired_revision,
        a.lifecycle AS agent_lifecycle,
        a.status AS agent_status,
        a.last_seen_at AS agent_last_seen_at,
        te.lifecycle AS tenant_lifecycle
      FROM agents a
      JOIN printers p
        ON p.agent_id = a.id
       AND p.tenant_id = a.tenant_id
      JOIN tenants te
        ON te.id = a.tenant_id
      WHERE a.id = ${agentId}
        AND a.tenant_id = ${tenantId}
        AND p.id = ${printerId}
        AND p.tenant_id = ${tenantId}
      FOR UPDATE OF a, p, te
    `);
    const owner = runtimeOwner.rows[0] as {
      printer_name?: string;
      printer_type?: string;
      printer_device_class?: string;
      printer_lifecycle?: string;
      printer_status?: string;
      printer_inventory_present?: boolean;
      printer_connection_type?: string;
      printer_protocol?: string;
      printer_agent_id?: string;
      management_source?: string;
      printer_capabilities?: { supported_protocols?: string[]; virtual_spooler_test?: boolean } | null;
      printer_config?: Record<string, unknown> | null;
      applied_desired_revision?: number | string;
      desired_revision?: number | string;
      agent_lifecycle?: string;
      agent_status?: string;
      agent_last_seen_at?: Date | string | null;
      tenant_lifecycle?: string;
    } | undefined;
    if (!owner || owner.printer_agent_id !== agentId) {
      throw new PrintJobInputError("Printer owner changed during enqueue; retry the print operation", "PRINTER_OWNER_CHANGED", 409);
    }
    // Tenant lifecycle re-check: closes the TOCTOU gap between auth and INSERT.
    if (owner.tenant_lifecycle !== "active") {
      throw new PrintJobInputError(`Workspace is ${owner.tenant_lifecycle ?? "unavailable"}`, "TENANT_UNAVAILABLE", 409);
    }
    const printerIdentity = {
      name: owner.printer_name,
      printerType: owner.printer_type,
      deviceClass: owner.printer_device_class,
      protocol: owner.printer_protocol,
      connectionType: owner.printer_connection_type,
      capabilities: owner.printer_capabilities,
      config: owner.printer_config,
      managementSource: owner.management_source,
    };
    // Strictly TEST-ONLY: both services must opt in, the row must be an
    // explicit Yaseir virtual capture, and only the authenticated Manager
    // test-print route supplies allowVirtualTestCapture. Production/Odoo/
    // reprint API jobs remain forbidden even when the feature is enabled.
    const virtualCaptureAuthorized = allowVirtualTestCapture === true
      && process.env.YASEIR_GATEWAY_VIRTUAL_TEST_MODE === "1"
      && requestedBy === "manager-test"
      && documentType === "test_page"
      && !rateLimitKeyId
      && !reprintOfJobId
      && isVirtualCaptureTestRecord(printerIdentity);
    const virtualSpoolerAuthorized = owner.management_source === "manager"
      && isApprovedVirtualSpoolerTestRecord(printerIdentity);
    if (isVirtualPrinterRecord(printerIdentity) && !virtualCaptureAuthorized && !virtualSpoolerAuthorized) {
      throw new PrintJobInputError("Virtual or redirected queue is not approved for printing; a Manager must explicitly enable a local Windows virtual spooler test destination and wait for Agent verification", "PRINTER_VIRTUAL", 409);
    }
    if (owner.printer_lifecycle !== "active") {
      throw new PrintJobInputError(`Printer is ${owner.printer_lifecycle ?? "unavailable"}`, "PRINTER_UNAVAILABLE", 409);
    }
    if (owner.printer_inventory_present === false) {
      throw new PrintJobInputError("Printer is no longer present in the Agent inventory", "PRINTER_UNAVAILABLE", 409);
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

    // Capability validation happens under the authoritative printer row
    // lock. An earlier inventory read can race with a manager
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

    // Auth can race with key removal/revocation or Odoo disabling printing.
    // Lock the live credential after billing locks, before reserving credit.
    if (rateLimitKeyId) {
      const credential = await tx.execute(sql`SELECT id FROM api_keys
        WHERE id = ${rateLimitKeyId} AND tenant_id = ${tenantId}
          AND revoked_at IS NULL AND read_only_until IS NULL AND odoo_enabled = TRUE
        FOR UPDATE`);
      if (!credential.rows.length) throw new PrintJobInputError("Integration credential is no longer active", "UNAUTHORIZED", 401);
    }

    // One newly-created logical print job consumes one plan print credit.
    // Existing idempotent jobs return before this point, so retries never
    // double-charge the same logical print.
    await reserveTenantPrintCredit(tx, tenantId);

    const counts = await tx.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE agent_id = ${agentId} AND status = 'queued' AND expires_at > now())::int AS agent_queued,
        -- pg_column_size() measures TOAST-compressed STORAGE bytes and can
        -- undercount a 5 MiB repetitive/base64 print payload by 100x+. The
        -- 128 MiB queue ceiling is a LOGICAL decoded-from-DB/HTTP memory
        -- budget: use uncompressed JSON text bytes for existing rows, just
        -- as we use JSON.stringify bytes for the incoming row. The agent
        -- lock above serializes admission, so the aggregate is atomic.
        COALESCE(SUM(octet_length(payload::text)) FILTER (WHERE agent_id = ${agentId} AND status = 'queued' AND expires_at > now()), 0)::bigint AS agent_queued_payload_bytes,
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
      expiresAt: effectiveExpiresAt,
      // Stamp creation from the SAME clock read used for the expiry window.
      // The column default is `now()` (transaction start), which drifts from
      // the `clock_timestamp()` read above inside a long transaction and makes
      // `created_at` disagree with `expires_at` and with the per-minute rate
      // window (`created_at >= now() - interval '1 minute'`).
      createdAt: dbNow,
      updatedAt: dbNow,
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
  if (typeof options.tenantId !== "string" || !options.tenantId.trim()) throw new PrintJobInputError("tenant context is required", "TENANT_CONTEXT_REQUIRED", 400);
  const requestedBy = normalizeRequestedBy(options.requestedBy);
  const validatedPayload = validatePrintJobPayload(payload);
  // Manager idempotency is verified only inside the owning transaction; an
  // optimistic read here would disclose a prior job after the actor was demoted.
  if (!options.managerAuthority && options.idempotencyKey) {
    const receipt = await db.query.printJobReceipts.findFirst({ where: and(eq(printJobReceipts.tenantId, options.tenantId), eq(printJobReceipts.idempotencyKey, options.idempotencyKey)) });
    if (receipt) {
      if ((options.rateLimitKeyId && receipt.apiKeyId === null) || receipt.fingerprint !== idempotencyDigest({ printerId: normalizedPrinterId, documentType: options.documentType, destination: options.destination, payload: validatedPayload })) throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), { code: "IDEMPOTENCY_CONFLICT" });
      return { id: receipt.id, printerId: receipt.printerId, agentId: receipt.agentId, status: receipt.status, isReused: true };
    }
  }
  const printer = await db.query.printers.findFirst({ where: and(eq(printers.id, normalizedPrinterId), eq(printers.tenantId, options.tenantId)) });
  if (!printer) throw new PrintJobInputError("Printer not found", "PRINTER_NOT_FOUND", 404);
  const ownerAgent = await db.query.agents.findFirst({ where: and(eq(agents.id, printer.agentId), eq(agents.tenantId, options.tenantId)) });
  if (!ownerAgent) throw new PrintJobInputError("Printer owner agent not found", "AGENT_NOT_FOUND", 404);

  const id = `job_${nanoid(12)}`;
  const expiresAt = options.expiresAt;
  if (expiresAt !== undefined && (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()))) {
    throw new PrintJobInputError("expiresAt must be a valid timestamp", "INVALID_REQUEST", 400);
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
    allowVirtualTestCapture: options.allowVirtualTestCapture === true,
    managerAuthority: options.managerAuthority,
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

  // Enterprise timeline: record created + queued (non-blocking)
  if (!result.isReused) {
    try {
      await recordJobEvent({
        jobId: result.jobId,
        tenantId: options.tenantId,
        stage: "created",
        status: "ok",
        message: "Job created in Gateway",
        agentId: result.agentId,
        printerId: result.printerId,
        requestId: options.requestId ?? undefined,
        metadata: { documentType: options.documentType, destination: options.destination },
      });
      await recordJobEvent({
        jobId: result.jobId,
        tenantId: options.tenantId,
        stage: "queued",
        status: "ok",
        message: `Queued for agent ${result.agentId}`,
        agentId: result.agentId,
        printerId: result.printerId,
        requestId: options.requestId ?? undefined,
      });
    } catch (error) {
      // Timeline persistence is best-effort; keep enqueue availability while
      // making the degraded audit trail observable.
      logWarn("print.job.timeline_persist_failed", {
        jobId: result.jobId,
        tenantId: options.tenantId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  if (result.isReused) {
    return { id: result.jobId, printerId: result.printerId, agentId: result.agentId, status: result.status, isReused: true };
  }

  return { id: result.jobId, printerId: printer.id, agentId: ownerAgent.id, status: "queued", isReused: false };
}
