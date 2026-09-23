import { db } from "../../../../db";
import { printJobs } from "../../../../db/schema";
import { validateAgent } from "../../../../lib/agent-auth";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isJobStatus, canTransition, isTerminal, derivePhysicalOutcome, AGENT_REQUEUE_REASONS, LATE_SUCCESS_POST_EXPIRATION_MARKER, type JobStatus } from "../../../../lib/job-status";
import { logInfo, logWarn, requestIdFrom } from "../../../../lib/log";
import { incrementMetric } from "../../../../lib/metrics";
import { STALE_CLAIM_SECONDS, MAX_RETRIES, DELIVERY_EVIDENCE_PENDING } from "../../../../lib/job-maintenance";
import { CLAIM_RETURNING, MAX_DELIVERY_ATTEMPTS, MAX_AGENT_IN_FLIGHT_JOBS } from "../../../../lib/job-delivery";
import { fencedJobWrite } from "../../../../lib/job-fencing";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { agentStaleThresholdSeconds } from "../../../../lib/agent-availability";
import { recordJobEvent } from "../../../../lib/job-timeline";
import { getCorrelationContext, generateAttemptId } from "../../../../server/correlation";
import { databaseNowMs } from "../../../../lib/database-clock";

export const dynamic = "force-dynamic";
const MAX_CLAIM_BATCH = 20;
const MAX_ERROR_LENGTH = 2000;

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

  const claimJobs = async (tx: { execute: typeof db.execute }) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agent.id}`}))`);

    const countResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs p
      JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
      JOIN printers pr ON pr.id = p.printer_id AND pr.tenant_id = p.tenant_id
      JOIN tenants t ON t.id = p.tenant_id
      WHERE p.agent_id = ${agent.id}
        AND p.status IN ('claimed', 'printing')
        AND p.expires_at > now()
        AND a.lifecycle = 'active'
        AND a.status = 'online'
        AND a.last_seen_at IS NOT NULL
        AND a.last_seen_at > now() - make_interval(secs => ${agentStaleThresholdSeconds()})
        AND pr.lifecycle = 'active'
        AND (pr.status = 'online' OR (pr.status = 'unknown' AND pr.connection_type = 'network' AND pr.protocol IN ('raw','escpos','zpl','tspl')))
        AND (pr.management_source = 'agent' OR pr.applied_desired_revision >= pr.desired_revision)
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
          AND p.updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
          AND p.retries < ${MAX_RETRIES}
          AND p.delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
          AND a.lifecycle = 'active'
          AND a.status = 'online'
        AND a.last_seen_at IS NOT NULL
        AND a.last_seen_at > now() - make_interval(secs => ${agentStaleThresholdSeconds()})
          AND pr.lifecycle = 'active'
          AND (pr.status = 'online' OR (pr.status = 'unknown' AND pr.connection_type = 'network' AND pr.protocol IN ('raw','escpos','zpl','tspl')))
        AND (pr.management_source = 'agent' OR pr.applied_desired_revision >= pr.desired_revision)
          AND t.lifecycle = 'active'
        ORDER BY p.created_at ASC
        LIMIT ${MAX_CLAIM_BATCH}
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
        AND a.last_seen_at > now() - make_interval(secs => ${agentStaleThresholdSeconds()})
          AND pr.lifecycle = 'active'
          AND (pr.status = 'online' OR (pr.status = 'unknown' AND pr.connection_type = 'network' AND pr.protocol IN ('raw','escpos','zpl','tspl')))
        AND (pr.management_source = 'agent' OR pr.applied_desired_revision >= pr.desired_revision)
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
        SELECT p.id
        FROM print_jobs p
        JOIN candidate_ids c ON c.id = p.id
        JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
        JOIN printers pr ON pr.id = p.printer_id AND pr.tenant_id = p.tenant_id
        JOIN tenants t ON t.id = p.tenant_id
        WHERE a.lifecycle = 'active'
          AND a.status = 'online'
        AND a.last_seen_at IS NOT NULL
        AND a.last_seen_at > now() - make_interval(secs => ${agentStaleThresholdSeconds()})
          AND pr.lifecycle = 'active'
          AND (pr.status = 'online' OR (pr.status = 'unknown' AND pr.connection_type = 'network' AND pr.protocol IN ('raw','escpos','zpl','tspl')))
        AND (pr.management_source = 'agent' OR pr.applied_desired_revision >= pr.desired_revision)
          AND t.lifecycle = 'active'
        ORDER BY c.priority ASC, c.created_at ASC
        LIMIT ${MAX_CLAIM_BATCH}
        FOR UPDATE OF p, a, pr, t SKIP LOCKED
      )
      UPDATE print_jobs
      SET
        status = 'claimed',
        claimed_at = now(),
        updated_at = now(),
        claim_token = gen_random_uuid()::text,
        acked_at = NULL,
        delivered_at = NULL,
        error = ${DELIVERY_EVIDENCE_PENDING},
        delivery_attempts = print_jobs.delivery_attempts + 1,
        retries = CASE WHEN print_jobs.status = 'claimed'
                       THEN print_jobs.retries + 1
                       ELSE print_jobs.retries END
      FROM claimable
      WHERE print_jobs.id = claimable.id
      RETURNING ${CLAIM_RETURNING}
    `);

    const rows = (claimed as unknown as { rows?: unknown[] })?.rows ?? (claimed as unknown as unknown[]);
    return Array.isArray(rows) ? rows : Array.isArray(claimed) ? claimed : [];
  };

  const rows = typeof (db as { transaction?: unknown }).transaction === "function"
    ? await db.transaction((tx) => claimJobs(tx as { execute: typeof db.execute }))
    : await claimJobs(db);

  return NextResponse.json((rows as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    expiresAt: toWireIso(row.expiresAt),
    createdAt: toWireIso(row.createdAt),
    physicalOutcome: derivePhysicalOutcome(String(row.status ?? ""), typeof row.error === "string" ? row.error : null),
  })));
}

function stageForStatus(status: string): "printing" | "success" | "failed" | "expired" | "blocked" | "delivery" | "accepted" | "connection" {
  switch(status){
    case "printing": return "printing";
    case "success": return "success";
    case "failed": return "failed";
    case "expired": return "expired";
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
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

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
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const currentStatus = job.status as JobStatus;
  if (requestedStatus !== "expired" && job.claimToken && claimToken !== job.claimToken) {
    logWarn("job.status.stale_claim", { requestId, jobId, agentId: agent.id });
    return NextResponse.json({ error: "Stale claim token: this attempt was superseded by a newer claim", code: "STALE_CLAIM", status: currentStatus }, { status: 409 });
  }

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
    const expiryError = currentStatus === "printing"
      ? "JOB_EXPIRED_DURING_PRINT: physical output is unknown"
      : currentStatus === "claimed" && Boolean(job.deliveredAt || job.ackedAt)
        ? "UNKNOWN_PARTIAL_DELIVERY: job expired after delivery without an execution report"
        : null;

    const expired = await db.update(printJobs)
      .set({
        status: "expired",
        error: expiryError,
        // Use DB-native now() to match the sweeper's clock (updated_at < now() - interval).
        // JS new Date() is the app-server clock and can drift from the DB host.
        updatedAt: sql`now()`,
        deliveredAt: sql`CASE WHEN ${printJobs.status} IN ('claimed', 'printing') THEN COALESCE(${printJobs.deliveredAt}, now()) ELSE ${printJobs.deliveredAt} END`,
      })
      .where(and(
        fencedJobWrite(jobId, agent.tenantId, agent.id, currentStatus, claimToken),
        sql`${printJobs.expiresAt} <= now()`,
      ))
      .returning({ status: printJobs.status, error: printJobs.error });

    if (expired.length === 1) {
      incrementMetric("print_jobs_expired_total");
      if (expiryError) incrementMetric("print_jobs_unknown_total");
      const physicalOutcome = derivePhysicalOutcome("expired", expiryError);
      logInfo("print.job.expired", { requestId, jobId, agentId: agent.id, physicalOutcome });
      try {
        await recordJobEvent({
          jobId,
          tenantId: agent.tenantId,
          stage: "expired",
          status: "error",
          message: expiryError ?? "Job expired",
          agentId: agent.id,
          printerId: job.printerId,
          requestId,
        });
      } catch (e) { logWarn("print.job.event_persist_failed", { requestId, jobId, stage: "expired", error: e instanceof Error ? e.message : "unknown" }); }
      return NextResponse.json({ success: true, status: "expired", physicalOutcome });
    }

    return NextResponse.json({ error: "Job has not expired or the worker claim is stale", code: "JOB_NOT_EXPIRED_OR_STALE" }, { status: 409 });
  }

  if (requestedStatus === "queued" && currentStatus === "claimed") {
    if (!AGENT_REQUEUE_REASONS.includes(reason as (typeof AGENT_REQUEUE_REASONS)[number])) {
      return NextResponse.json({ error: "Invalid status transition: claimed -> queued requires an explicit pre-execution rejection reason" }, { status: 409 });
    }
    const updated = await db.update(printJobs)
      .set({
        status: "queued",
        claimToken: null,
        deliveredAt: null,
        ackedAt: null,
        claimedAt: null,
        error: `Agent returned job before execution (${reason})`,
        updatedAt: sql`now()`,
        // This is a provably pre-execution hand-back: no printer bytes were
        // sent. Refund the delivery attempt so the physical-delivery budget
        // reflects only real hand-offs, while still incrementing retries to
        // bound repeated admission/requeue loops.
        deliveryAttempts: sql`GREATEST(${printJobs.deliveryAttempts} - 1, 0)`,
        retries: sql`${printJobs.retries} + 1`,
      })
      .where(and(
        fencedJobWrite(jobId, agent.tenantId, agent.id, currentStatus, claimToken),
        lateSuccess ? sql`\${printJobs.updatedAt} >= now() - interval '24 hours' AND \${printJobs.updatedAt} <= now()` : sql`TRUE`,
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
    const lateSuccessMarker = job.error?.startsWith("AGENT_EXECUTION_TIMEOUT")
      || job.error?.startsWith("AGENT_RESTART_DURING_PRINT");
    if (!lateSuccessMarker) {
      return NextResponse.json({ error: "Invalid status transition: failed -> success (late success not allowed for this job)" }, { status: 409 });
    }
    // The age window is enforced atomically by PostgreSQL below, so the Gateway
    // database clock is authoritative even when the app host clock drifts.
    lateSuccess = true;
  }

  if (currentStatus === "expired" && requestedStatus === "success") {
    // The five-minute grace window is enforced atomically by PostgreSQL below.
    const postExpiryError = `${LATE_SUCCESS_POST_EXPIRATION_MARKER}: print execution completed after TTL expiry${errorMessage ? ` (${errorMessage})` : ""}`.slice(0, MAX_ERROR_LENGTH);
    const postExpired = await db.update(printJobs)
      .set({
        status: "success",
        error: postExpiryError,
        // Invalidate the claim token on terminal success: completed jobs must
        // not retain a live token that could confuse future status checks.
        claimToken: sql`NULL`,
        // DB-native now() to stay on the same clock as the sweeper.
        updatedAt: sql`now()`,
        deliveredAt: sql`COALESCE(${printJobs.deliveredAt}, now())`,
      })
      .where(and(
        fencedJobWrite(jobId, agent.tenantId, agent.id, currentStatus, claimToken),
        sql`\${printJobs.expiresAt} <= now()`,
        sql`\${printJobs.expiresAt} > now() - interval '5 minutes'`,
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

  if (!canTransition(currentStatus, requestedStatus, { allowLateSuccess: lateSuccess })) {
    return NextResponse.json({ error: `Invalid status transition: ${currentStatus} -> ${requestedStatus}` }, { status: 409 });
  }

  const nextError = lateSuccess ? `LATE_SUCCESS: ${job.error ?? "AGENT_EXECUTION_TIMEOUT"}` : errorMessage;
  const updated = await db.update(printJobs)
    .set({
      status: requestedStatus,
      error: nextError,
      // Invalidate the claim token when the job reaches a terminal state
      // (success, failed). A completed job must never retain a live token.
      ...(isTerminal(requestedStatus) ? { claimToken: sql`NULL` } : {}),
      // DB-native now() to match the sweeper's clock (updated_at < now() - interval).
      updatedAt: sql`now()`,
      deliveredAt: sql`COALESCE(${printJobs.deliveredAt}, now())`,
    })
    .where(fencedJobWrite(jobId, agent.tenantId, agent.id, currentStatus, claimToken))
    .returning({ status: printJobs.status, error: printJobs.error });

  if (updated.length !== 1) {
    const winner = await db.query.printJobs.findFirst({ where: whereClause });
    const winnerStatus = winner?.status as JobStatus | undefined;
    return NextResponse.json({ error: `Concurrent status transition rejected${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
  }

  const physicalOutcome = derivePhysicalOutcome(requestedStatus, nextError);
  incrementMetric(`print_jobs_${requestedStatus}_total`);
  if (physicalOutcome === "unknown") incrementMetric("print_jobs_unknown_total");
  if (lateSuccess) {
    incrementMetric("print_jobs_late_success_total");
    logInfo("print.job.late_success", { requestId, jobId, agentId: agent.id, physicalOutcome });
  }
  logInfo(`print.job.${requestedStatus}`, { requestId, jobId, agentId: agent.id, physicalOutcome, spoolerJobId, attemptId: incomingAttemptId, transport });

  // Persist spoolerJobId if provided (Gateway↔Spooler linking) — enterprise requirement
  if (spoolerJobId) {
    try {
      await db.update(printJobs).set({ spoolerJobId, updatedAt: sql`now()` } as any).where(and(eq(printJobs.id, jobId), eq(printJobs.tenantId, agent.tenantId)));
    } catch (error) {
      logWarn("print.job.spooler_link_persist_failed", { requestId, jobId, spoolerJobId, error: error instanceof Error ? error.message : "unknown" });
    }
  }

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