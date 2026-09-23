import { db } from "../db";
import { sql } from "drizzle-orm";
import { incrementMetric } from "./metrics";

export const STALE_CLAIM_SECONDS = 90;
export const STALE_PRINTING_SECONDS = 10 * 60;
export const MAX_RETRIES = 5;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const DELIVERY_EVIDENCE_PENDING = "DELIVERY_EVIDENCE_PENDING";

export async function sweepPrintJobs(scope: { agentId?: string } = {}): Promise<{ expired: number; requeuedClaims: number; silentDeliveries: number; stalePrinting: number; exhaustedClaims: number; exhaustedQueued: number }> {
  const agentFilter = scope.agentId ? sql`AND agent_id = ${scope.agentId}` : sql``;

  // SWEEP BATCH SIZE: each UPDATE is bounded to SWEEP_BATCH_SIZE rows per tick.
  // Without a LIMIT, a backlog after a DB outage could lock tens of thousands
  // of rows in a single statement, causing >30s statement timeouts and
  // cascading failures. Remaining rows are processed in subsequent sweep ticks
  // without contention (SKIP LOCKED prevents worker pile-up).
  const SWEEP_BATCH = Number(process.env.MAINTENANCE_SWEEP_LIMIT ?? 200);

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
        AND updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
        AND retries < ${MAX_RETRIES} AND expires_at > now() ${agentFilter}
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
        AND updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS}) ${agentFilter}
      ORDER BY updated_at ASC
      LIMIT ${SWEEP_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET status='failed',
      error='UNKNOWN_PARTIAL_DELIVERY: claim lease expired after delivery without an execution report (physical output is unknown; manual reconciliation required)',
      claim_token=NULL,
      claimed_at=NULL,
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
      claim_token=NULL,
      claimed_at=NULL,
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
        AND updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
        AND retries >= ${MAX_RETRIES} ${agentFilter}
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
        AND retries >= ${MAX_RETRIES} ${agentFilter}
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
