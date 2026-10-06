import { db } from "../db";
import { inArray, sql } from "drizzle-orm";
import { printJobs, printJobReceipts } from "../db/schema";
import { incrementMetric } from "./metrics";
import { idempotencyDigest } from "./print-job-service";
import { PRINT_JOB_RETENTION_HOURS } from "../shared/job-retention";
import { agentStaleThresholdSeconds } from "./stale-threshold";

// Claim-lease staleness historically hardcoded at 90s. It now follows the same
// STALE_AGENT_THRESHOLD_SECONDS env as the presence/claim gates so tuning the
// env cannot diverge the UI/offline display from sweeper requeue behavior.
// STALE_CLAIM_SECONDS is kept as the default/fallback value (deprecated alias).
export const STALE_CLAIM_SECONDS = 90;
export const STALE_PRINTING_SECONDS = 10 * 60;
export const MAX_RETRIES = 5;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const DELIVERY_EVIDENCE_PENDING = "DELIVERY_EVIDENCE_PENDING";

const DEFAULT_RETENTION_BATCH = 500;

/**
 * Remove bulky terminal Gateway jobs after the shared 48-hour retention
 * window. A payload-free receipt is kept so idempotency and duplicate-print
 * protection survive without retaining document bytes forever.
 *
 * claim_token MUST already be cleared: ambiguous outcomes retain their fence
 * for the 24-hour late-reconciliation window, so 48-hour retention cannot
 * erase an attempt that is still reconcilable.
 */
export async function cleanupTerminalPrintJobs(scope: { agentId?: string } = {}): Promise<number> {
  const parsedLimit = Number(process.env.JOB_RETENTION_SWEEP_LIMIT);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.floor(parsedLimit), 5000)
    : DEFAULT_RETENTION_BATCH;
  const agentFilter = scope.agentId ? sql`AND agent_id = ${scope.agentId}` : sql``;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('print_jobs:retention:v1'))`);
    const candidates = await tx.execute(sql`
      SELECT id
      FROM print_jobs
      WHERE status IN ('success','failed','expired')
        AND claim_token IS NULL
        AND updated_at <= now() - make_interval(hours => ${PRINT_JOB_RETENTION_HOURS})
        ${agentFilter}
      ORDER BY updated_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const ids = candidates.rows.map((row) => String((row as { id: unknown }).id));
    if (ids.length === 0) return 0;

    const rows = await tx.select().from(printJobs).where(inArray(printJobs.id, ids));
    if (rows.length === 0) return 0;

    await tx.insert(printJobReceipts).values(rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      idempotencyKey: row.idempotencyKey,
      fingerprint: idempotencyDigest({
        printerId: row.printerId,
        documentType: row.documentType,
        destination: row.destination,
        payload: row.payload,
      }),
      printerId: row.printerId,
      agentId: row.agentId,
      apiKeyId: row.apiKeyId,
      destination: row.destination,
      documentType: row.documentType,
      requestedBy: row.requestedBy,
      status: row.status,
      error: row.error,
      closedClaimTokenHash: row.closedClaimTokenHash,
      deliveredAt: row.deliveredAt,
      ackedAt: row.ackedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))).onConflictDoNothing();

    const deleted = await tx.delete(printJobs).where(inArray(printJobs.id, ids));
    const count = deleted.rowCount ?? 0;
    if (count > 0) incrementMetric("print_jobs_retention_deleted_total", count);
    return count;
  });
}

export async function sweepPrintJobs(scope: { agentId?: string } = {}): Promise<{ expired: number; requeuedClaims: number; silentDeliveries: number; stalePrinting: number; exhaustedClaims: number; exhaustedQueued: number }> {
  const agentFilter = scope.agentId ? sql`AND agent_id = ${scope.agentId}` : sql``;

  // SWEEP BATCH SIZE: each UPDATE is bounded to SWEEP_BATCH_SIZE rows per tick.
  // Without a LIMIT, a backlog after a DB outage could lock tens of thousands
  // of rows in a single statement, causing >30s statement timeouts and
  // cascading failures. Remaining rows are processed in subsequent sweep ticks
  // without contention (SKIP LOCKED prevents worker pile-up).
  const parsedLimit = Number(process.env.MAINTENANCE_SWEEP_LIMIT);
  const SWEEP_BATCH = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 200;

  const expired = await db.execute(sql`
    WITH candidates AS (
      SELECT id FROM print_jobs
      WHERE status NOT IN ('success','failed','expired') AND expires_at <= now() ${agentFilter}
      ORDER BY expires_at ASC
      LIMIT ${SWEEP_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET status='expired',
      error=CASE
        WHEN status='printing' THEN 'JOB_EXPIRED_DURING_PRINT: physical output is unknown (full, partial or none)'
        WHEN status='claimed' AND (delivered_at IS NOT NULL OR acked_at IS NOT NULL OR error = 'DELIVERY_EVIDENCE_PENDING')
          THEN 'UNKNOWN_PARTIAL_DELIVERY: job expired after delivery without an execution report (physical output is unknown)'
        ELSE NULL END,
      -- Preserve the exact execution fence only for ambiguous delivered
      -- attempts so an in-flight Agent may reconcile a late success inside the
      -- bounded grace window. Never preserve a token for an unclaimed or
      -- pre-dispatch expiry. A later cleanup removes preserved tokens after the
      -- reconciliation window closes.
      claim_token=CASE
        WHEN status='printing' AND claim_token IS NOT NULL THEN claim_token
        WHEN status='claimed' AND claim_token IS NOT NULL
          AND (delivered_at IS NOT NULL OR acked_at IS NOT NULL OR error = 'DELIVERY_EVIDENCE_PENDING')
          THEN claim_token
        ELSE NULL END,
      claimed_at=CASE
        WHEN status='printing' AND claim_token IS NOT NULL THEN claimed_at
        WHEN status='claimed' AND claim_token IS NOT NULL
          AND (delivered_at IS NOT NULL OR acked_at IS NOT NULL OR error = 'DELIVERY_EVIDENCE_PENDING')
          THEN claimed_at
        ELSE NULL END,
      updated_at=now()
    FROM candidates
    WHERE print_jobs.id = candidates.id
    RETURNING print_jobs.id, print_jobs.status, print_jobs.error
  `);

  // A claim whose lease expired WITHOUT any evidence of delivery (no
  // delivered_at, no ack, and no in-flight WebSocket evidence marker) is
  // provably pre-dispatch: the agent never received the job, so re-queueing it
  // can print nothing twice. A WebSocket delivery with evidence persistence
  // still pending is deliberately NOT auto-requeued: the frame may already
  // have reached the agent, and converting that ambiguity into a requeue can
  // duplicate physical output.
  const requeuedClaims = await db.execute(sql`
    WITH candidates AS (
      SELECT id FROM print_jobs
      WHERE status='claimed' AND delivered_at IS NULL AND acked_at IS NULL
        AND COALESCE(error, '') <> 'DELIVERY_EVIDENCE_PENDING'
        AND updated_at < now() - make_interval(secs => ${agentStaleThresholdSeconds()})
        AND retries < ${MAX_RETRIES} AND delivery_attempts < ${MAX_DELIVERY_ATTEMPTS} AND expires_at > now() ${agentFilter}
      ORDER BY updated_at ASC
      LIMIT ${SWEEP_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET status='queued', claimed_at=NULL, claim_token=NULL,
      delivered_at=NULL, acked_at=NULL,
      retries=retries+1, updated_at=now()
    FROM candidates
    WHERE print_jobs.id = candidates.id
    RETURNING print_jobs.id
  `);

  // Delivered-but-silent claims: the job bytes reached the agent but no
  // execution report ever arrived within the lease window. The physical
  // outcome is genuinely unknown; the job becomes terminal-failed with an
  // unknown-outcome marker so nothing is ever reprinted automatically.
  const silentDeliveries = await db.execute(sql`
    WITH candidates AS (
      SELECT id FROM print_jobs
      WHERE status='claimed'
        AND (delivered_at IS NOT NULL OR acked_at IS NOT NULL OR error = 'DELIVERY_EVIDENCE_PENDING')
        AND updated_at < now() - make_interval(secs => ${agentStaleThresholdSeconds()}) ${agentFilter}
      ORDER BY updated_at ASC
      LIMIT ${SWEEP_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET status='failed',
      error='UNKNOWN_PARTIAL_DELIVERY: claim lease expired after delivery without an execution report (physical output is unknown; reconciliation is allowed only for the same fenced attempt)',
      -- Preserve the original claim fence and claimed_at so a delayed result
      -- from the exact delivery attempt can still reconcile the outcome.
      -- The late-success path imposes its own bounded age check; no automatic
      -- retry/failover is introduced by keeping this evidence.
      claim_token=claim_token,
      claimed_at=claimed_at,
      updated_at=now()
    FROM candidates
    WHERE print_jobs.id = candidates.id
    RETURNING print_jobs.id
  `);

  const stalePrinting = await db.execute(sql`
    WITH candidates AS (
      SELECT id FROM print_jobs
      WHERE status='printing' AND updated_at < now() - make_interval(secs => ${STALE_PRINTING_SECONDS}) ${agentFilter}
      ORDER BY updated_at ASC
      LIMIT ${SWEEP_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET status='failed',
      error=CASE WHEN expires_at <= now()
        THEN 'JOB_EXPIRED_DURING_PRINT: physical output is unknown (full, partial or none)'
        ELSE 'AGENT_EXECUTION_TIMEOUT: agent execution lease expired (physical output is unknown; manual reconciliation required)' END,
      -- Preserve the original claim token for AGENT_EXECUTION_TIMEOUT so a
      -- late success from that exact execution attempt can still be reconciled
      -- inside the 24-hour fenced window. Expiry-at-print is not eligible for
      -- failed->success reconciliation, so its token can be cleared normally.
      claim_token=CASE WHEN expires_at <= now() THEN NULL ELSE claim_token END,
      claimed_at=CASE WHEN expires_at <= now() THEN NULL ELSE claimed_at END,
      updated_at=now()
    FROM candidates
    WHERE print_jobs.id = candidates.id
    RETURNING print_jobs.id, print_jobs.error
  `);

  const exhaustedClaims = await db.execute(sql`
    WITH candidates AS (
      SELECT id FROM print_jobs
      WHERE status='claimed' AND delivered_at IS NULL AND acked_at IS NULL
        AND COALESCE(error, '') <> 'DELIVERY_EVIDENCE_PENDING'
        AND updated_at < now() - make_interval(secs => ${agentStaleThresholdSeconds()})
        AND (retries >= ${MAX_RETRIES} OR delivery_attempts >= ${MAX_DELIVERY_ATTEMPTS}) ${agentFilter}
      ORDER BY updated_at ASC
      LIMIT ${SWEEP_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET status='failed',
      error='exceeded max retries after a stale claim (agent likely crashed or lost connection)',
      claim_token=NULL,
      claimed_at=NULL,
      updated_at=now()
    FROM candidates
    WHERE print_jobs.id = candidates.id
    RETURNING print_jobs.id
  `);

  const exhaustedQueued = await db.execute(sql`
    WITH candidates AS (
      SELECT id FROM print_jobs
      WHERE status='queued' AND expires_at > now()
        AND (retries >= ${MAX_RETRIES} OR delivery_attempts >= ${MAX_DELIVERY_ATTEMPTS}) ${agentFilter}
      ORDER BY created_at ASC
      LIMIT ${SWEEP_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET status='failed',
      error='exceeded max retries before delivery',
      claim_token=NULL,
      claimed_at=NULL,
      updated_at=now()
    FROM candidates
    WHERE print_jobs.id = candidates.id
    RETURNING print_jobs.id
  `);

  // Once the bounded late-success reconciliation windows close, remove
  // preserved execution fences from terminal rows. Keeping them longer would
  // retain stale execution credentials after their recovery purpose expires.
  // Bounded like every other sweep statement: a post-outage backlog of
  // ambiguous rows must not hold one long UPDATE past statement_timeout.
  await db.execute(sql`
    WITH candidates AS (
      SELECT id FROM print_jobs
      WHERE status = 'expired'
        AND claim_token IS NOT NULL
        AND expires_at <= now() - interval '5 minutes'
        ${agentFilter}
      LIMIT ${SWEEP_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET claim_token = NULL, claimed_at = NULL
    FROM candidates WHERE print_jobs.id = candidates.id
  `);
  await db.execute(sql`
    WITH candidates AS (
      SELECT id FROM print_jobs
      WHERE status = 'failed'
        AND claim_token IS NOT NULL
        AND (
          error LIKE 'UNKNOWN_PARTIAL_DELIVERY:%'
          OR error LIKE 'AGENT_EXECUTION_TIMEOUT:%'
          OR error LIKE 'AGENT_RESTART_DURING_PRINT:%'
        )
        AND updated_at <= now() - interval '24 hours'
        ${agentFilter}
      LIMIT ${SWEEP_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET claim_token = NULL, claimed_at = NULL
    FROM candidates WHERE print_jobs.id = candidates.id
  `);

  const result = {
    expired: expired.rows.length,
    requeuedClaims: requeuedClaims.rows.length,
    silentDeliveries: silentDeliveries.rows.length,
    stalePrinting: stalePrinting.rows.length,
    exhaustedClaims: exhaustedClaims.rows.length,
    exhaustedQueued: exhaustedQueued.rows.length,
  };
  const unknownExpiryCount = expired.rows.filter((row) => String((row as { error?: unknown }).error ?? "").startsWith("JOB_EXPIRED_DURING_PRINT") || String((row as { error?: unknown }).error ?? "").startsWith("UNKNOWN_PARTIAL_DELIVERY")).length;
  if (result.expired > 0) incrementMetric("print_jobs_expired_total", result.expired);
  if (unknownExpiryCount > 0) incrementMetric("print_jobs_unknown_total", unknownExpiryCount);
  if (result.requeuedClaims > 0) incrementMetric("print_jobs_requeued_total", result.requeuedClaims);
  if (result.silentDeliveries > 0) {
    incrementMetric("print_jobs_failed_total", result.silentDeliveries);
    incrementMetric("print_jobs_unknown_total", result.silentDeliveries);
  }
  if (result.stalePrinting > 0) {
    incrementMetric("print_jobs_failed_total", result.stalePrinting);
    incrementMetric("print_jobs_unknown_total", result.stalePrinting);
  }
  if (result.exhaustedClaims > 0) incrementMetric("print_jobs_failed_total", result.exhaustedClaims);
  if (result.exhaustedQueued > 0) incrementMetric("print_jobs_failed_total", result.exhaustedQueued);
  return result;
}
