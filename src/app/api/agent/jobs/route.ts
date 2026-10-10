import { createHash } from "node:crypto";
import { db } from "../../../../db";
import { printJobs, printJobReceipts } from "../../../../db/schema";
import { validateAgent } from "../../../../lib/agent-auth";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isJobStatus, canTransition, isTerminal, derivePhysicalOutcome, AGENT_REQUEUE_REASONS, AGENT_REPRINT_AFTER_CRASH_REASON, LATE_SUCCESS_POST_EXPIRATION_MARKER, LATE_SUCCESS_ERROR_MARKERS, LATE_SUCCESS_MAX_AGE_MS, EXPIRED_LATE_SUCCESS_GRACE_MS, type JobStatus } from "../../../../lib/job-status";
import { logInfo, logWarn, requestIdFrom } from "../../../../lib/log";
import { incrementMetric } from "../../../../lib/metrics";
import { MAX_RETRIES, DELIVERY_EVIDENCE_PENDING } from "../../../../lib/job-maintenance";
import { CLAIM_RETURNING, MAX_DELIVERY_ATTEMPTS, MAX_AGENT_IN_FLIGHT_JOBS } from "../../../../lib/job-delivery";
import { fencedJobWrite, printingAdmissionLifecycleFence } from "../../../../lib/job-fencing";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { agentStaleThresholdSeconds, printerStaleThresholdSeconds } from "../../../../lib/agent-availability";
import { refreshClockSkew } from "../../../../lib/database-clock";
import { liveTenantSubscriptionPredicate } from "../../../../lib/entitlements";
import { recordJobEvent } from "../../../../lib/job-timeline";

export const dynamic = "force-dynamic";
const printerEligibilityPredicate = (tenantId: SQL) => sql`
  pr.lifecycle = 'active'
  AND pr.inventory_present = true
  AND (
    pr.status = 'online'
    OR pr.status = 'busy'
    OR (
      pr.status = 'unknown'
      AND (
        pr.connection_type = 'spooler'
        OR pr.connection_type IN ('ipp','ipps')
        OR (pr.connection_type = 'network' AND pr.protocol IN ('ipp','ipps'))
        OR (pr.connection_type IN ('network','usb') AND pr.protocol IN ('raw','escpos','zpl','tspl'))
      )
    )
  )
  AND (
    pr.management_source = 'agent'
    OR (
      pr.applied_desired_revision >= pr.desired_revision
      AND pr.observed_desired_revision >= pr.desired_revision
    )
  )
  AND pr.last_seen_at IS NOT NULL
  AND pr.last_seen_at <= now()
  AND pr.last_seen_at >= now() - make_interval(secs => ${printerStaleThresholdSeconds()})
  AND ${liveTenantSubscriptionPredicate(tenantId)}
`;

const MAX_CLAIM_BATCH = 20;
const MAX_ERROR_LENGTH = 2000;

// Select only the jobs whose combined encoded JSON payloads fit the Agent's
// poll reader (20 x 5 MiB). This budget MUST be applied BEFORE the UPDATE:
// claiming first and trimming the HTTP response would leave never-sent jobs
// marked DELIVERY_EVIDENCE_PENDING, so maintenance would treat them as an
// ambiguous physical delivery and forbid their automatic retry.
const MAX_POLL_RESPONSE_BYTES = 64 * 1024 * 1024;
// Covers all non-payload wire fields, JSON framing and escaping. The SQL
// budget uses octet_length(payload::text), including the full encoded JSON
// payload (not just data.length), so this is deliberately conservative.
const POLL_ROW_OVERHEAD_BYTES = 2048;

/**
 * CLAIM_RETURNING rows come back from raw execute() as naive UTC timestamp
 * strings (node-postgres identity parsers). Emit RFC3339/ISO-8601 with a
 * trailing Z so the Go agent's time.Parse(time.RFC3339) succeeds and the
 * agent-side expiry gate stays enabled on the poll path.
 */
function toWireIso(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || !value) return value;
  let iso = value.replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) {
    iso += /[+-]\d{2}$/.test(iso) ? ":00" : "Z";
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/**
 * Poll claim. Two candidate classes, both fenced by the delivery boundary
 * and BOTH attempt budgets (delivery_attempts < MAX_DELIVERY_ATTEMPTS and
 * retries < MAX_RETRIES) — a reclaim that increments delivery_attempts must
 * respect the same ceiling as the WS-claim and queued-poll paths:
 *
 *  1. Stale claims that were NEVER delivered (no delivered_at, no ack):
 *     provably pre-dispatch, safe to re-deliver under a fresh claim token.
 *  2. Queued jobs not yet claimed.
 *
 * A claim whose lease expired AFTER delivery is deliberately absent here: the
 * delivery sweep fails those with an unknown-outcome marker instead, because
 * re-delivering could print a document twice.
 *
 * claimed != delivered: the poll claim does NOT stamp delivered_at. Committing
 * a row is not proof the HTTP response reached the agent; delivery evidence
 * is stamped only when the agent demonstrably holds the job (WebSocket send +
 * fenced mark, fenced job_ack, or a fenced status report on the claim).
 */
export async function GET(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // The presence gates below compare `a.last_seen_at` against PostgreSQL `now()`.
  // Calibrate the JS clock (used for Retry-After and availability edges) so both
  // sides agree even when the host clock drifts from the database clock.
  await refreshClockSkew();

  const claimJobs = async (tx: { execute: typeof db.execute }) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agent.id}`}))`);

    // Capacity accounting must include all unexpired claimed/printing jobs owned
    // by this Agent — EXCEPT stale claims that this very poll is about to
    // reclaim. A stale no-evidence claim reuses its own executor slot when
    // reclaimed (it never left the agent's budget), so counting it as
    // occupied would permanently starve reclaims whenever the fleet sits at
    // the cap. Everything else (fresh claims, printing, delivered) counts:
    // printer health and billing are claim-eligibility gates, not capacity
    // gates; otherwise stale/offline printers can disappear from the count
    // and a recovered Agent can exceed its bounded local executor limit.
    // The exclusion predicate mirrors stale_candidates below exactly.
    const countResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs p
      JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
      JOIN tenants t ON t.id = p.tenant_id
      WHERE p.agent_id = ${agent.id}
        AND p.status IN ('claimed', 'printing')
        AND p.expires_at > now()
        AND NOT (
          p.status = 'claimed'
          AND p.delivered_at IS NULL
          AND p.acked_at IS NULL
          AND COALESCE(p.error, '') <> ${DELIVERY_EVIDENCE_PENDING}
          AND p.updated_at < now() - make_interval(secs => ${agentStaleThresholdSeconds()})
          AND p.retries < ${MAX_RETRIES}
          AND p.delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
        )
        AND a.lifecycle = 'active'
        AND a.status = 'online'
        AND a.last_seen_at IS NOT NULL
        AND a.last_seen_at <= now()
        AND a.last_seen_at >= now() - make_interval(secs => ${agentStaleThresholdSeconds()})
        AND t.lifecycle = 'active'
    `);
    const inFlight = Number((countResult.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
    const remainingSlots = Math.max(0, MAX_AGENT_IN_FLIGHT_JOBS - inFlight);
    const queuedLimit = Math.min(MAX_CLAIM_BATCH, remainingSlots);

    const claimed = await tx.execute(sql`
      WITH stale_candidates AS (
        SELECT p.id, p.created_at, 0 AS priority
        FROM print_jobs p
        JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
        JOIN printers pr ON pr.id = p.printer_id AND pr.tenant_id = p.tenant_id
        JOIN tenants t ON t.id = p.tenant_id
        WHERE p.agent_id = ${agent.id}
          AND p.expires_at > now()
          AND p.status = 'claimed'
          AND p.delivered_at IS NULL
          AND p.acked_at IS NULL
          AND COALESCE(p.error, '') <> ${DELIVERY_EVIDENCE_PENDING}
          AND p.updated_at < now() - make_interval(secs => ${agentStaleThresholdSeconds()})
          AND p.retries < ${MAX_RETRIES}
          AND p.delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
          AND a.lifecycle = 'active'
          AND a.status = 'online'
        AND a.last_seen_at IS NOT NULL
        AND a.last_seen_at <= now()
        AND a.last_seen_at >= now() - make_interval(secs => ${agentStaleThresholdSeconds()})
          AND ${printerEligibilityPredicate(sql`p.tenant_id`)}
          AND t.lifecycle = 'active'
        ORDER BY p.created_at ASC
        LIMIT ${queuedLimit}
      ),
      queued_candidates AS (
        SELECT p.id, p.created_at, 1 AS priority
        FROM print_jobs p
        JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
        JOIN printers pr ON pr.id = p.printer_id AND pr.tenant_id = p.tenant_id
        JOIN tenants t ON t.id = p.tenant_id
        WHERE p.agent_id = ${agent.id}
          AND p.expires_at > now()
          AND p.status = 'queued'
          AND p.delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
          AND p.retries < ${MAX_RETRIES}
          AND ${queuedLimit} > 0
          AND a.lifecycle = 'active'
          AND a.status = 'online'
        AND a.last_seen_at IS NOT NULL
        AND a.last_seen_at <= now()
        AND a.last_seen_at >= now() - make_interval(secs => ${agentStaleThresholdSeconds()})
          AND ${printerEligibilityPredicate(sql`p.tenant_id`)}
          AND t.lifecycle = 'active'
        ORDER BY p.created_at ASC
        LIMIT ${queuedLimit}
      ),
      candidate_ids AS (
        SELECT id, created_at, priority FROM stale_candidates
        UNION ALL
        SELECT id, created_at, priority FROM queued_candidates
      ),
      claimable AS (
        SELECT p.id, c.priority, c.created_at
        FROM print_jobs p
        JOIN candidate_ids c ON c.id = p.id
        JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
        JOIN printers pr ON pr.id = p.printer_id AND pr.tenant_id = p.tenant_id
        JOIN tenants t ON t.id = p.tenant_id
        WHERE a.lifecycle = 'active'
          AND a.status = 'online'
        AND a.last_seen_at IS NOT NULL
        AND a.last_seen_at <= now()
        AND a.last_seen_at >= now() - make_interval(secs => ${agentStaleThresholdSeconds()})
          AND ${printerEligibilityPredicate(sql`p.tenant_id`)}
          AND t.lifecycle = 'active'
        ORDER BY c.priority ASC, c.created_at ASC
        LIMIT ${queuedLimit}
        FOR UPDATE OF p, a, pr, t SKIP LOCKED
      ),
      ranked_claimable AS (
        SELECT c.id,
          SUM(octet_length(p.payload::text) + ${POLL_ROW_OVERHEAD_BYTES}) OVER (
            ORDER BY c.priority, c.created_at, c.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS estimated_response_bytes
        FROM claimable c
        JOIN print_jobs p ON p.id = c.id
      ),
      bounded_claimable AS (
        SELECT id FROM ranked_claimable
        WHERE estimated_response_bytes <= ${MAX_POLL_RESPONSE_BYTES}
      )
      UPDATE print_jobs
      SET
        status = 'claimed',
        claimed_at = now(),
        updated_at = now(),
        claim_token = gen_random_uuid()::text,
        closed_claim_token_hash = NULL,
        acked_at = NULL,
        delivered_at = NULL,
        error = ${DELIVERY_EVIDENCE_PENDING},
        delivery_attempts = print_jobs.delivery_attempts + 1,
        retries = CASE WHEN print_jobs.status = 'claimed'
                       THEN print_jobs.retries + 1
                       ELSE print_jobs.retries END
      FROM bounded_claimable
      WHERE print_jobs.id = bounded_claimable.id
        AND ${liveTenantSubscriptionPredicate(sql`print_jobs.tenant_id`)}
      RETURNING ${CLAIM_RETURNING}
    `);

    const rows = (claimed as unknown as { rows?: unknown[] })?.rows ?? (claimed as unknown as unknown[]);
    return Array.isArray(rows) ? rows : Array.isArray(claimed) ? claimed : [];
  };

  const rows = typeof (db as { transaction?: unknown }).transaction === "function"
    ? await db.transaction((tx) => claimJobs(tx as { execute: typeof db.execute }))
    : await claimJobs(db);

  const mapped = (rows as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    expiresAt: toWireIso(row.expiresAt),
    createdAt: toWireIso(row.createdAt),
    physicalOutcome: derivePhysicalOutcome(String(row.status ?? ""), typeof row.error === "string" ? row.error : null),
  }));

  // Every claimed row fits the conservative response budget by construction.
  // Never truncate here: returning fewer jobs than we claimed would turn
  // undelivered jobs into permanent unknown-outcome failures.
  return NextResponse.json(mapped);
}

function stageForStatus(status: string): "printing" | "success" | "failed" | "expired" | "blocked" | "delivery" | "accepted" | "connection" {
  switch(status){
    case "printing": return "printing";
    case "success": return "success";
    case "failed": return "failed";
    case "expired": return "expired";
    case "blocked": return "blocked";
    case "delivery": return "delivery";
    case "accepted": return "accepted";
    case "connection": return "connection";
    default: return "printing";
  }
}

export async function PATCH(req: Request) {
  const requestId = requestIdFrom(req);
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) {
    logWarn("job.status.unauthorized", { requestId });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (hasBodyOverLimit(req, 64 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });

  let body: { jobId?: unknown; status?: unknown; error?: unknown; reason?: unknown; claimToken?: unknown; spoolerJobId?: unknown; attemptId?: unknown; transport?: unknown };
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { jobId, status: requestedStatus, error: rawError, reason: rawReason, claimToken: rawClaimToken, spoolerJobId: rawSpoolerJobId, attemptId: rawAttemptId, transport: rawTransport } = body;
  if (typeof jobId !== "string" || !jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  if (!isJobStatus(requestedStatus)) return NextResponse.json({ error: "status must be a valid job status" }, { status: 400 });
  const errorMessage = typeof rawError === "string" && rawError.length > 0 ? rawError.slice(0, MAX_ERROR_LENGTH) : null;
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  const claimToken = typeof rawClaimToken === "string" && rawClaimToken.length > 0 && rawClaimToken.length <= 120 ? rawClaimToken : null;
  const spoolerJobId = typeof rawSpoolerJobId === "string" && rawSpoolerJobId.length > 0 && rawSpoolerJobId.length <= 64 ? rawSpoolerJobId.trim() : null;
  const incomingAttemptId = typeof rawAttemptId === "string" && rawAttemptId.length > 0 && rawAttemptId.length <= 64 ? rawAttemptId.trim() : null;
  const transport = typeof rawTransport === "string" ? rawTransport.trim().slice(0,32) : null;

  const whereClause = and(eq(printJobs.id, jobId), eq(printJobs.tenantId, agent.tenantId), eq(printJobs.agentId, agent.id));
  const job = await db.query.printJobs.findFirst({ where: whereClause });
  if (!job) {
    const receipt = await db.query.printJobReceipts.findFirst({ where: and(eq(printJobReceipts.id, jobId), eq(printJobReceipts.tenantId, agent.tenantId), eq(printJobReceipts.agentId, agent.id)) });
    if (receipt && claimToken && receipt.status === requestedStatus && receipt.closedClaimTokenHash === createHash("sha256").update(claimToken).digest("hex")) {
      return NextResponse.json({ success: true, status: receipt.status, physicalOutcome: derivePhysicalOutcome(receipt.status, receipt.error) });
    }
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const currentStatus = job.status as JobStatus;
  const closedClaimTokenHash = claimToken ? createHash("sha256").update(claimToken).digest("hex") : null;
  if (claimToken && closedClaimTokenHash && isTerminal(currentStatus) && requestedStatus === currentStatus) {
    // Replay acknowledges durable evidence only. It cannot reopen execution,
    // replace an outcome, extend the late-success window, or alter spooler data.
    const acknowledged = await db.update(printJobs)
      .set({ status: currentStatus })
      .where(and(whereClause, eq(printJobs.status, currentStatus), eq(printJobs.closedClaimTokenHash, closedClaimTokenHash)))
      .returning({ status: printJobs.status, error: printJobs.error });
    if (acknowledged.length === 1) {
      return NextResponse.json({ success: true, status: acknowledged[0].status, physicalOutcome: derivePhysicalOutcome(acknowledged[0].status, acknowledged[0].error) });
    }
  }
  if (requestedStatus !== "expired") {
    // Every non-expiry lifecycle report must prove ownership of an actual
    // Gateway claim. A tokenless queued/legacy row is never a valid basis for
    // printing, success, failure, or pre-execution requeue: otherwise any
    // authenticated Agent that knows a queued job id could manufacture a
    // terminal state without ever receiving the claim.
    if (!job.claimToken || !claimToken || claimToken !== job.claimToken) {
      logWarn("job.status.stale_or_missing_claim", { requestId, jobId, agentId: agent.id, currentStatus });
      return NextResponse.json({ error: "A valid claim token is required for this status transition", code: "CLAIM_REQUIRED", status: currentStatus }, { status: 409 });
    }
  }

  // A lost acknowledgement may require admission replay. It must use the
  // same locked runtime/lifecycle checks as the first admission below.
  const printingAdmissionReplay = requestedStatus === "printing" && currentStatus === "printing";

  if (requestedStatus === "expired") {
    // Guard: a terminal job (success, failed, expired) must never be re-expired.
    // The claim-token check above is intentionally skipped for expired requests
    // (line 194), so this is the only in-memory gate preventing a stale agent
    // from flipping an already-success/failed job to expired. The fenced DB write
    // below is a second layer, but an explicit 409 here avoids unnecessary DB
    // round-trips and is self-documenting.
    if (isTerminal(currentStatus)) {
      logWarn("job.status.expired_on_terminal", { requestId, jobId, agentId: agent.id, currentStatus });
      return NextResponse.json({ error: `Job is already terminal (${currentStatus}); expiry not allowed`, code: "JOB_ALREADY_TERMINAL", status: currentStatus }, { status: 409 });
    }
    // Classify expiry from the CURRENT PostgreSQL row, not the earlier
    // unprotected SELECT. An ACK/evidence write may commit between the read
    // above and this UPDATE, while the claim's status/token remain the same.
    // In particular, DELIVERY_EVIDENCE_PENDING (used by both WS and polling)
    // already means the HTTP/frame handoff MAY have reached the Agent. It is
    // not evidence of paper output, and cannot become definite non-printing.
    const expiryError = sql`CASE
      WHEN ${printJobs.status} = 'printing'
        THEN 'JOB_EXPIRED_DURING_PRINT: physical output is unknown'
      WHEN ${printJobs.status} = 'claimed' AND (
        ${printJobs.deliveredAt} IS NOT NULL OR ${printJobs.ackedAt} IS NOT NULL
        OR ${printJobs.error} = ${DELIVERY_EVIDENCE_PENDING}
      ) THEN 'UNKNOWN_PARTIAL_DELIVERY: job expired after possible delivery without an execution report'
      ELSE NULL END`;

    const expired = await db.update(printJobs)
      .set({
        status: "expired",
        error: expiryError,
        // Use DB-native now() to match the sweeper's clock (updated_at < now() - interval).
        // JS new Date() is the app-server clock and can drift from the DB host.
        updatedAt: sql`now()`,
        // Same delivery-evidence rule as the status-transition path below:
        // only a printing expiry may stamp deliveredAt (the agent provably
        // holds the job). A claimed-but-undelivered expiry keeps error=null
        // (honest not_printed) and must not gain delivery proof, or the row
        // would later look reconcilable/partially-delivered without basis.
        ...(currentStatus === "printing"
          ? { deliveredAt: sql`COALESCE(${printJobs.deliveredAt}, now())` }
          : {}),
      })
      .where(and(
        fencedJobWrite(jobId, agent.tenantId, agent.id, currentStatus, claimToken),
        sql`${printJobs.expiresAt} <= now()`,
      ))
      .returning({ status: printJobs.status, error: printJobs.error });

    if (expired.length === 1) {
      // Returning the persisted error avoids another SELECT/UPDATE race: the
      // response, metrics and audit event must describe the same DB outcome.
      const persistedError = expired[0].error;
      incrementMetric("print_jobs_expired_total");
      const physicalOutcome = derivePhysicalOutcome("expired", persistedError);
      if (physicalOutcome === "unknown") incrementMetric("print_jobs_unknown_total");
      logInfo("print.job.expired", { requestId, jobId, agentId: agent.id, physicalOutcome });
      try {
        await recordJobEvent({
          jobId,
          tenantId: agent.tenantId,
          stage: "expired",
          status: "error",
          message: persistedError ?? "Job expired",
          agentId: agent.id,
          printerId: job.printerId,
          requestId,
        });
      } catch (e) { logWarn("print.job.event_persist_failed", { requestId, jobId, stage: "expired", error: e instanceof Error ? e.message : "unknown" }); }
      return NextResponse.json({ success: true, status: "expired", physicalOutcome });
    }

    return NextResponse.json({ error: "Job has not expired or the worker claim is stale", code: "JOB_NOT_EXPIRED_OR_STALE" }, { status: 409 });
  }

  if (requestedStatus === "queued" && currentStatus === "printing") {
    if (reason !== AGENT_REPRINT_AFTER_CRASH_REASON) {
      return NextResponse.json({ error: "Invalid status transition: printing -> queued is reserved for explicit crash-reprint recovery" }, { status: 409 });
    }

    // This is an explicit opt-in at-least-once recovery policy. The prior
    // attempt already crossed the physical boundary, so never refund
    // deliveryAttempts and never allow this path after the business TTL.
    const updated = await db.update(printJobs)
      .set({
        status: "queued",
        claimToken: null,
        closedClaimTokenHash: null,
        claimedAt: null,
        deliveredAt: null,
        ackedAt: null,
        error: "AGENT_RESTART_DURING_PRINT: operator-enabled at-least-once crash recovery; prior physical outcome is unknown and a new delivery may duplicate output",
        retries: sql`${printJobs.retries} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(
        fencedJobWrite(jobId, agent.tenantId, agent.id, currentStatus, claimToken),
        sql`${printJobs.expiresAt} > now()`,
        sql`${printJobs.retries} < ${MAX_RETRIES}`,
      ))
      .returning({ status: printJobs.status, retries: printJobs.retries });

    if (updated.length !== 1) {
      return NextResponse.json({ error: "Crash requeue rejected: claim is stale, job expired, or retry budget is exhausted", code: "CRASH_REQUEUE_REJECTED" }, { status: 409 });
    }

    incrementMetric("print_jobs_requeued_total");
    logWarn("print.job.crash_requeued_at_least_once", { requestId, jobId, agentId: agent.id });
    try {
      await recordJobEvent({
        jobId,
        tenantId: agent.tenantId,
        stage: "queued",
        status: "error",
        message: "Agent restart recovery requeued a physically ambiguous attempt under explicit at-least-once policy",
        agentId: agent.id,
        printerId: job.printerId,
        requestId,
        metadata: {
          reason: AGENT_REPRINT_AFTER_CRASH_REASON,
          priorDeliveredAt: job.deliveredAt ? String(job.deliveredAt) : null,
          priorAckedAt: job.ackedAt ? String(job.ackedAt) : null,
        },
      });
    } catch (error) {
      logWarn("print.job.event_persist_failed", { requestId, jobId, stage: "queued", error: error instanceof Error ? error.message : "unknown" });
    }
    return NextResponse.json({ success: true, status: "queued", physicalOutcome: "unknown", requeuedAfterCrash: true });
  }

  if (requestedStatus === "queued" && currentStatus === "claimed") {
    if (!AGENT_REQUEUE_REASONS.includes(reason as (typeof AGENT_REQUEUE_REASONS)[number])) {
      return NextResponse.json({ error: "Invalid status transition: claimed -> queued requires an explicit pre-execution rejection reason" }, { status: 409 });
    }
    const updated = await db.update(printJobs)
      .set({
        status: "queued",
        claimToken: null,
        closedClaimTokenHash: null,
        deliveredAt: null,
        ackedAt: null,
        claimedAt: null,
        error: `Agent returned job before execution (${reason})`,
        updatedAt: sql`now()`,
        // claimed has not crossed printing admission, even when WS delivery
        // and ACK evidence exist. This is a pre-execution hand-back: no printer bytes were
        // sent. Refund the delivery attempt so the physical-delivery budget
        // reflects only real hand-offs, while still incrementing retries to
        // bound repeated admission/requeue loops.
        deliveryAttempts: sql`GREATEST(${printJobs.deliveryAttempts} - 1, 0)`,
        retries: sql`${printJobs.retries} + 1`,
      })
      .where(and(
        fencedJobWrite(jobId, agent.tenantId, agent.id, currentStatus, claimToken),
        sql`${printJobs.expiresAt} > now()`,
        sql`${printJobs.retries} < ${MAX_RETRIES}`,
      ))
      .returning({ status: printJobs.status, error: printJobs.error });
    if (updated.length !== 1) {
      const winner = await db.query.printJobs.findFirst({ where: whereClause });
      const winnerStatus = winner?.status as JobStatus | undefined;
      return NextResponse.json({ error: `Concurrent status transition rejected${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
    }
    incrementMetric("print_jobs_rejected_total");
    logInfo("print.job.rejected", { requestId, jobId, agentId: agent.id, reason, physicalOutcome: "not_printed" });
    try {
      await recordJobEvent({
        jobId,
        tenantId: agent.tenantId,
        stage: "blocked",
        status: "blocked",
        message: `Agent returned before execution: ${reason}`,
        agentId: agent.id,
        printerId: job.printerId,
        requestId,
        metadata: { reason },
      });
    } catch (error) {
      logWarn("print.job.event_persist_failed", { requestId, jobId, stage: "queued", error: error instanceof Error ? error.message : "unknown" });
    }
    return NextResponse.json({ success: true, status: "queued", physicalOutcome: "not_printed" });
  }

  let lateSuccess = false;
  if (currentStatus === "failed" && requestedStatus === "success") {
    const executionTimeoutLateSuccess = job.error?.startsWith("AGENT_EXECUTION_TIMEOUT")
      || job.error?.startsWith("AGENT_RESTART_DURING_PRINT");
    // The sweeper's persisted UNKNOWN_PARTIAL_DELIVERY marker is itself
    // evidence that a polled/WS payload MAY have reached this claimed Agent.
    // A lost response can leave deliveredAt and ackedAt null even if the
    // Agent later executes the document. Reconciliation must allow the exact
    // original claim, not require a second (possibly lost) ACK as proof.
    const deliveryUnknownLateSuccess = job.error?.startsWith("UNKNOWN_PARTIAL_DELIVERY")
      && Boolean(job.claimedAt && job.claimToken);
    if (!executionTimeoutLateSuccess && !deliveryUnknownLateSuccess) {
      return NextResponse.json({ error: "Invalid status transition: failed -> success (late success not allowed for this job)" }, { status: 409 });
    }
    // Require both the durable UNKNOWN marker and the exact live claim
    // token. This cannot initiate printing or reconcile an unclaimed/legacy
    // row, and the database UPDATE independently enforces a 24-hour window.
    if (deliveryUnknownLateSuccess && (!job.claimedAt || !job.claimToken || !claimToken || claimToken !== job.claimToken)) {
      return NextResponse.json({
        error: "Unknown delivery outcome lacks a matching fenced execution attempt",
        code: "DELIVERY_RECONCILIATION_NOT_POSSIBLE",
        status: currentStatus,
      }, { status: 409 });
    }
    // The age window is enforced atomically by PostgreSQL below, so the Gateway
    // database clock is authoritative even when the app host clock drifts.
    lateSuccess = true;
  }

  if (currentStatus === "expired" && requestedStatus === "success") {
    // Late success is a reconciliation of the EXACT original claim, never
    // a new submission. A pending handoff at expiry cannot legitimately stamp
    // delivered_at, but the server's persisted UNKNOWN marker plus a valid
    // claim token and a subsequent authenticated Agent result may still
    // establish an execution result. Keep claims with no ambiguity evidence
    // ineligible (especially unclaimed/undelivered expired queued jobs).
    const expiredLateSuccessMarker = (job.error ?? "").startsWith("JOB_EXPIRED_DURING_PRINT")
      || (job.error ?? "").startsWith("UNKNOWN_PARTIAL_DELIVERY");
    const possibleDelivery = Boolean(job.deliveredAt || job.ackedAt)
      || (job.error ?? "").startsWith("UNKNOWN_PARTIAL_DELIVERY");
    if (!job.claimedAt || !job.claimToken || !claimToken || claimToken !== job.claimToken || !possibleDelivery || !expiredLateSuccessMarker) {
      return NextResponse.json({
        error: "Expired job lacks a matching delivered execution attempt; late success is not allowed",
        code: "EXPIRED_JOB_ATTEMPT_NOT_RECONCILIABLE",
        status: currentStatus,
      }, { status: 409 });
    }
    // The five-minute grace window is enforced atomically by PostgreSQL below.
    const postExpiryError = `${LATE_SUCCESS_POST_EXPIRATION_MARKER}: print execution completed after TTL expiry${errorMessage ? ` (${errorMessage})` : ""}`.slice(0, MAX_ERROR_LENGTH);
    const postExpired = await db.update(printJobs)
      .set({
        status: "success",
        error: postExpiryError,
        // Invalidate the claim token on terminal success: completed jobs must
        // not retain a live token that could confuse future status checks.
        claimToken: sql`NULL`,
        closedClaimTokenHash,
        // DB-native now() to stay on the same clock as the sweeper.
        updatedAt: sql`now()`,
        deliveredAt: sql`COALESCE(${printJobs.deliveredAt}, now())`,
      })
      .where(and(
        fencedJobWrite(jobId, agent.tenantId, agent.id, currentStatus, claimToken),
        sql`${printJobs.expiresAt} <= now()`,
        // Bound by EXPIRED_LATE_SUCCESS_GRACE_MS (single source in job-status.ts).
        sql`${printJobs.expiresAt} > now() - make_interval(secs => ${Math.floor(EXPIRED_LATE_SUCCESS_GRACE_MS / 1000)})`,
      ))
      .returning({ status: printJobs.status, error: printJobs.error });
    if (postExpired.length !== 1) {
      const winner = await db.query.printJobs.findFirst({ where: whereClause });
      const winnerStatus = winner?.status as JobStatus | undefined;
      return NextResponse.json({ error: `Concurrent status transition rejected${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
    }
    const physicalOutcome = derivePhysicalOutcome("success", postExpiryError);
    incrementMetric("print_jobs_success_total");
    incrementMetric("print_jobs_late_success_total");
    logInfo("print.job.success_post_expiration", { requestId, jobId, agentId: agent.id, physicalOutcome: LATE_SUCCESS_POST_EXPIRATION_MARKER });
    return NextResponse.json({ success: true, status: "success", physicalOutcome, physicalDetail: LATE_SUCCESS_POST_EXPIRATION_MARKER });
  }

  if (!printingAdmissionReplay && !canTransition(currentStatus, requestedStatus, { allowLateSuccess: lateSuccess })) {
    return NextResponse.json({ error: `Invalid status transition: ${currentStatus} -> ${requestedStatus}` }, { status: 409 });
  }

  const nextError = lateSuccess ? `LATE_SUCCESS: ${job.error ?? "AGENT_EXECUTION_TIMEOUT"}` : errorMessage;
  const retainsLateSuccessFence = requestedStatus === "failed"
    && LATE_SUCCESS_ERROR_MARKERS.some((marker) => nextError?.startsWith(marker));
  const runStatusUpdate = (executor: Pick<typeof db, "update">) => executor.update(printJobs)
    .set({
      status: requestedStatus,
      error: nextError,
      ...(isTerminal(requestedStatus) ? { closedClaimTokenHash } : {}),
      ...(isTerminal(requestedStatus) && !retainsLateSuccessFence ? { claimToken: sql`NULL` } : {}),
      updatedAt: sql`now()`,
      // deliveredAt is delivery EVIDENCE: it must only be stamped when the
      // agent provably received the job (entering printing/success, or a
      // printing->failed report where delivery already happened at the
      // printing step). Stamping it on claimed->failed pre-execution or
      // claimed->queued rejection fabricates evidence: the expiry sweeper
      // treats delivered_at as proof of delivery and marks the job
      // UNKNOWN_PARTIAL_DELIVERY, blocking auto-retry and forcing
      // unknown-outcome handling for a job that provably never dispatched.
      ...((requestedStatus === "printing" || requestedStatus === "success" || (requestedStatus === "failed" && currentStatus === "printing"))
        ? { deliveredAt: sql`COALESCE(${printJobs.deliveredAt}, now())` }
        : {}),
      // Spooler linkage is part of the same claim-fenced status transition.
      // A second id+tenant-only UPDATE here could let a stale attempt overwrite
      // current-attempt spooler evidence after this lifecycle UPDATE commits.
      ...(spoolerJobId ? { spoolerJobId } : {}),
    })
    .where(and(
      fencedJobWrite(jobId, agent.tenantId, agent.id, currentStatus, claimToken),
      lateSuccess ? sql`${printJobs.updatedAt} >= now() - make_interval(secs => ${Math.floor(LATE_SUCCESS_MAX_AGE_MS / 1000)}) AND ${printJobs.updatedAt} <= now()` : requestedStatus === "printing" ? sql`${printJobs.expiresAt} > now()` : sql`TRUE`,
      // New physical-execution admission must serialize with the CURRENT
      // agent and tenant lifecycle at the statement boundary, not just at
      // authentication time: disabling the agent or suspending its tenant
      // between validateAgent and this UPDATE must not grant printing
      // admission. Terminal reconciliation stays independent of this gate.
      // The transaction below also locks the current runtime printer: an
      // Agent's desired-state snapshot may lag an operator disable/reconfigure.
      ...(requestedStatus === "printing" ? printingAdmissionLifecycleFence(agent.id, agent.tenantId) : []),
    ))
    .returning({ status: printJobs.status, error: printJobs.error });

  let updated: Array<{ status: string; error: string | null }>;
  if (requestedStatus === "printing") {
    updated = await db.transaction(async (tx) => {
      const lockedJob = await tx.execute(sql`
        SELECT id FROM print_jobs
        WHERE id = ${jobId} AND tenant_id = ${agent.tenantId} AND agent_id = ${agent.id}
        FOR UPDATE
      `);
      if (lockedJob.rows.length !== 1) return [];

      const lifecycle = await tx.execute(sql`
        SELECT a.lifecycle AS agent_lifecycle, t.lifecycle AS tenant_lifecycle,
               pr.lifecycle AS printer_lifecycle, pr.inventory_present,
               pr.management_source, pr.desired_revision,
               pr.applied_desired_revision, pr.observed_desired_revision
        FROM agents a
        JOIN tenants t ON t.id = a.tenant_id
        JOIN printers pr ON pr.tenant_id = a.tenant_id AND pr.agent_id = a.id
        WHERE a.id = ${agent.id} AND a.tenant_id = ${agent.tenantId}
          AND pr.id = ${job.printerId}
          AND ${printerEligibilityPredicate(sql`a.tenant_id`)}
        FOR SHARE OF a, t, pr
      `);
      const row = lifecycle.rows[0] as {
        agent_lifecycle?: unknown; tenant_lifecycle?: unknown;
        printer_lifecycle?: unknown; inventory_present?: unknown;
        management_source?: unknown; desired_revision?: number | string;
        applied_desired_revision?: number | string; observed_desired_revision?: number | string;
      } | undefined;
      if (row?.agent_lifecycle !== "active" || row.tenant_lifecycle !== "active"
        || row.printer_lifecycle !== "active" || row.inventory_present !== true) return [];
      if (row.management_source === "manager" && (
        Number(row.applied_desired_revision) < Number(row.desired_revision)
        || Number(row.observed_desired_revision) < Number(row.desired_revision)
      )) return [];

      return runStatusUpdate(tx);
    });
  } else {
    updated = await runStatusUpdate(db);
  }

  if (updated.length !== 1) {
    const winner = await db.query.printJobs.findFirst({ where: whereClause });
    const winnerStatus = winner?.status as JobStatus | undefined;
    return NextResponse.json({ error: `Concurrent status transition rejected${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
  }

  if (printingAdmissionReplay) {
    return NextResponse.json({ success: true, status: "printing", physicalOutcome: "unknown" });
  }

  const physicalOutcome = derivePhysicalOutcome(requestedStatus, nextError);
  incrementMetric(`print_jobs_${requestedStatus}_total`);
  if (physicalOutcome === "unknown") incrementMetric("print_jobs_unknown_total");
  if (lateSuccess) {
    incrementMetric("print_jobs_late_success_total");
    logInfo("print.job.late_success", { requestId, jobId, agentId: agent.id, physicalOutcome });
  }
  logInfo(`print.job.${requestedStatus}`, { requestId, jobId, agentId: agent.id, physicalOutcome, spoolerJobId, attemptId: incomingAttemptId, transport });


  // Record timeline event (non-blocking for main flow)
  try {
    const stage = stageForStatus(requestedStatus);
    await recordJobEvent({
      jobId,
      tenantId: agent.tenantId,
      stage,
      status: requestedStatus === "success" ? "ok" : requestedStatus === "failed" ? "error" : "ok",
      message: requestedStatus === "printing" ? `Agent started printing (transport=${transport ?? "unknown"})` : requestedStatus === "success" ? `Print success (spoolerJobId=${spoolerJobId ?? "n/a"})` : nextError ?? requestedStatus,
      errorCode: requestedStatus === "failed" ? nextError ?? undefined : undefined,
      spoolerJobId: spoolerJobId ?? undefined,
      attemptId: incomingAttemptId ?? job.attemptId ?? undefined,
      claimId: claimToken ?? job.claimToken ?? undefined,
      agentId: agent.id,
      printerId: job.printerId,
      requestId,
      metadata: { transport, physicalOutcome, lateSuccess },
    });
  } catch (e) { logWarn("print.job.event_persist_failed", { requestId, jobId, stage: stageForStatus(requestedStatus), error: e instanceof Error ? e.message : "unknown" }); }

  return NextResponse.json({ success: true, status: requestedStatus, physicalOutcome, spoolerJobId });
}
