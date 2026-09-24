import { liveTenantSubscriptionPredicate } from "./entitlements";
import { db } from "../db";
import { printJobs } from "../db/schema";
import { and, sql } from "drizzle-orm";
import { fencedDeliveryWrite } from "./job-fencing";
import { STALE_CLAIM_SECONDS, MAX_DELIVERY_ATTEMPTS, MAX_RETRIES, DELIVERY_EVIDENCE_PENDING } from "./job-maintenance";
import { agentStaleThresholdSeconds, printerStaleThresholdSeconds } from "./agent-availability";

/**
 * Hard ceiling on live (claimed + printing, unexpired) jobs per agent.
 * Defined HERE - the claim-ownership home - and imported by the creation
 * admission check (print-job-service) and the poll batch sizer
 * (agent/jobs route), so the three sites can never diverge.
 */
// The Gateway must never claim more jobs than the Agent can accept locally.
// Agent maxPendingJobs is 64 (executing + waiting), so this is the shared
// Gateway-side ceiling for both WebSocket and polling claim paths.
export const MAX_AGENT_IN_FLIGHT_JOBS = 64;

/**
 * Ownership rules for handing a job to an agent.
 *
 * The Gateway owns runtime delivery state. A queued job is eligible only when
 * its owning agent and runtime printer are still active, fresh, and executable
 * at the delivery boundary, and the tenant still has an active billing
 * entitlement. Odoo business entities are intentionally not part of this
 * transaction.
 *
 * Every claim mints a fresh `claim_token` (see migration 0024). Agents must
 * echo it on status updates so a stale worker — an attempt whose lease
 * expired and was reclaimed — is rejected by a DB-enforced ownership
 * predicate, not by an in-memory convention.
 *
 * COUNTER CONTRACT (single coherent definition, proven by ws-claim-delivery
 * and job-maintenance tests):
 *   delivery_attempts = hand-off ATTEMPTS: every claim that resulted in the
 *     job leaving the Gateway toward an agent (WebSocket frame sent or poll
 *     response returned). A release after a failed/unevidenced hand-off
 *     KEEPS the charge (the frame may have reached the agent — ambiguity is
 *     budget-bound, never retried freely). A fenced pre-execution rejection
 *     (pending_full / agent_shutting_down / ledger_unavailable) REFUNDS it:
 *     the agent provably transmitted zero bytes, so burning the physical
 *     budget would let a saturated agent expire healthy jobs (LAW 9).
 *   retries = safe returns to 'queued': pre-execution rejections, stale-claim
 *     re-deliveries, and sweep requeues. Bounds hand-back loops independently
 *     of the delivery ceiling.
 * Both ceilings gate BOTH claim paths (WS `claimJobForDelivery` and the poll
 * stale/queued candidates); no path may claim past either.
 */
export const CLAIM_LEASE_SECONDS = STALE_CLAIM_SECONDS;
export { MAX_DELIVERY_ATTEMPTS };

export type ClaimedJobRow = {
  id: string;
  tenantId: string;
  agentId: string;
  printerId: string;
  documentType: string | null;
  status: string;
  payload: unknown;
  expiresAt: Date | string;
  retries: number;
  deliveryAttempts: number;
  claimToken: string | null;
  error?: string | null;
  createdAt: Date | string;
  requestId: string | null;
};

export const CLAIM_RETURNING = sql`
  print_jobs.id AS id,
  print_jobs.tenant_id AS "tenantId",
  print_jobs.agent_id AS "agentId",
  print_jobs.printer_id AS "printerId",
  print_jobs.document_type AS "documentType",
  print_jobs.status AS status,
  print_jobs.payload AS payload,
  print_jobs.expires_at AS "expiresAt",
  print_jobs.retries AS retries,
  print_jobs.delivery_attempts AS "deliveryAttempts",
  print_jobs.claim_token AS "claimToken",
  print_jobs.error AS error,
  print_jobs.created_at AS "createdAt",
  print_jobs.request_id AS "requestId"
`;

/**
 * Atomically take ownership of one queued job for `agentId`.
 *
 * Eligibility is checked again at the delivery boundary while the runtime
 * owner rows are locked. PostgreSQL's `FOR UPDATE SKIP LOCKED` pattern keeps
 * concurrent agents from claiming the same job. BOTH attempt budgets are
 * enforced HERE so no path can claim a job past its ceilings:
 * `delivery_attempts` bounds real hand-offs to the agent, `retries` bounds
 * safe returns to the queue (pre-execution rejections and stale-claim
 * re-deliveries refund/consume the RETRY budget, never the delivery budget -
 * zero bytes transmitted must not exhaust the physical-delivery allowance).
 */
export async function claimJobForDelivery(
  jobId: string,
  agentId: string,
  options: { markDeliveryEvidencePending?: boolean } = {},
): Promise<ClaimedJobRow | null> {
  const claimError = options.markDeliveryEvidencePending
    ? sql`${DELIVERY_EVIDENCE_PENDING}`
    : sql`${printJobs.error}`;
  return db.transaction(async (tx) => {
    // Same advisory lock the poll claim path and the creation admission
    // check take: concurrent WS pushes and polls for one agent serialize
    // here, so the in-flight ceiling below is a true invariant, not a
    // best-effort pre-check that racing claims could overshoot.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agentId}`}))`);
    const live = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs p
      JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
      JOIN tenants t ON t.id = p.tenant_id
      WHERE p.agent_id = ${agentId}
        AND p.status IN ('claimed', 'printing')
        AND p.expires_at > now()
        AND a.lifecycle = 'active'
        AND a.status = 'online'
        AND a.last_seen_at IS NOT NULL
        AND a.last_seen_at > now() - make_interval(secs => ${agentStaleThresholdSeconds()})
        AND t.lifecycle = 'active'
    `);
    const inFlight = Number((live.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
    if (inFlight >= MAX_AGENT_IN_FLIGHT_JOBS) return null;
    const locked = await tx.execute(sql`
      SELECT p.id
      FROM print_jobs p
      JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
      JOIN printers pr ON pr.id = p.printer_id AND pr.tenant_id = p.tenant_id
      JOIN tenants t ON t.id = p.tenant_id
      WHERE p.id = ${jobId}
        AND p.tenant_id = a.tenant_id
        AND p.agent_id = ${agentId}
        AND p.status = 'queued'
        AND p.expires_at > now()
        AND p.delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
        AND p.retries < ${MAX_RETRIES}
        AND a.lifecycle = 'active'
        AND a.status = 'online'
        AND a.last_seen_at IS NOT NULL
        AND a.last_seen_at > now() - make_interval(secs => ${agentStaleThresholdSeconds()})
        AND pr.lifecycle = 'active'
        AND (pr.status = 'online' OR (pr.status = 'unknown' AND pr.connection_type = 'network' AND pr.protocol IN ('raw','escpos','zpl','tspl')))
        AND (pr.management_source = 'agent' OR (
          pr.applied_desired_revision >= pr.desired_revision
          AND pr.observed_desired_revision >= pr.desired_revision
        ))
        AND pr.last_seen_at IS NOT NULL
        AND pr.last_seen_at > now() - make_interval(secs => ${printerStaleThresholdSeconds()})
        AND t.lifecycle = 'active'
        AND ${liveTenantSubscriptionPredicate(sql`p.tenant_id`)}
      FOR UPDATE OF p, a, pr, t SKIP LOCKED
    `);
    if (locked.rows.length === 0) return null;

    const claimed = await tx.execute(sql`
      UPDATE print_jobs
      SET status = 'claimed',
          claimed_at = now(),
          updated_at = now(),
          claim_token = gen_random_uuid()::text,
          delivered_at = NULL,
          acked_at = NULL,
          error = ${claimError},
          delivery_attempts = print_jobs.delivery_attempts + 1
      WHERE id = ${jobId}
        AND tenant_id = (SELECT tenant_id FROM agents WHERE id = ${agentId})
        AND agent_id = ${agentId}
        AND status = 'queued'
        AND expires_at > now()
        AND ${liveTenantSubscriptionPredicate(sql`print_jobs.tenant_id`)}
      RETURNING ${CLAIM_RETURNING}
    `);
    return (claimed.rows[0] as ClaimedJobRow | undefined) ?? null;
  });
}

export async function markJobDelivered(jobId: string, tenantId: string, agentId: string, claimToken: string | null): Promise<boolean> {
  const res = await db.update(printJobs)
    .set({
      // DB-native now() so delivered_at and updated_at are on the same clock
      // as the sweeper's updated_at < now() - interval comparisons.
      deliveredAt: sql`now()`,
      error: sql`CASE WHEN ${printJobs.error} = ${DELIVERY_EVIDENCE_PENDING} THEN NULL ELSE ${printJobs.error} END`,
      updatedAt: sql`now()`,
    })
    .where(fencedDeliveryWrite(jobId, tenantId, agentId, claimToken, ["claimed", "printing"]))
    .returning({ id: printJobs.id });
  return res.length > 0;
}

/**
 * The WebSocket send path has crossed the Gateway -> Agent boundary when the
 * socket accepted the frame, but delivery evidence may still fail to persist.
 * That condition is physically ambiguous: never requeue the job merely because
 * the evidence write failed, or the same job could be delivered a second time
 * while the first Agent attempt is already printing.
 *
 * The update is fenced to the exact claim token and only the pre-execution
 * 'claimed' state. If the Agent already moved the job to 'printing' (or a
 * concurrent actor made it terminal), this helper deliberately does nothing;
 * the existing state is already the authoritative outcome path.
 */
export async function markJobDeliveryUnknown(
  jobId: string,
  tenantId: string,
  agentId: string,
  claimToken: string | null,
): Promise<boolean> {
  const res = await db.update(printJobs)
    .set({
      status: "failed",
      error: "UNKNOWN_PARTIAL_DELIVERY: WebSocket frame was accepted but delivery evidence could not be persisted; physical output is unknown (manual reconciliation required)",
      deliveredAt: sql`COALESCE(${printJobs.deliveredAt}, now())`,
      claimToken: sql`NULL`,
      updatedAt: sql`now()`,
    })
    .where(fencedDeliveryWrite(jobId, tenantId, agentId, claimToken, ["claimed"]))
    .returning({ id: printJobs.id });
  return res.length > 0;
}

export async function recordJobAck(jobId: string, tenantId: string, agentId: string, claimToken?: string | null): Promise<boolean> {
  const res = await db.update(printJobs)
    // ACK means the Agent admitted the job into its bounded local executor.
    // Transport delivery evidence is recorded separately by markJobDelivered().
    .set({ ackedAt: sql`COALESCE(${printJobs.ackedAt}, now())`, updatedAt: sql`now()` })
    // A WebSocket close notification is an optimisation, not an authority:
    // PostgreSQL LISTEN/NOTIFY is not a durable queue and a listener can be
    // disconnected during a lifecycle transition.  Keep the durable Agent
    // lifecycle as the authorization boundary for agent-originated ACKs, so a
    // revoked socket cannot mutate delivery state merely because its close
    // notification was missed or delayed.
    .where(and(
      fencedDeliveryWrite(jobId, tenantId, agentId, claimToken, ["claimed", "printing"]),
      sql`EXISTS (
        SELECT 1 FROM agents a
        WHERE a.id = ${agentId}
          AND a.tenant_id = ${tenantId}
          AND a.lifecycle = 'active'
      )`,
    ))
    .returning({ id: printJobs.id });
  return res.length > 0;
}

export type ReleaseOutcome = "requeued" | "failed" | "noop";

export async function releaseUndeliveredClaim(jobId: string, tenantId: string, agentId: string, claimToken: string | null, reason: string): Promise<ReleaseOutcome> {
  const requeued = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'queued',
        claimed_at = NULL,
        claim_token = NULL,
        updated_at = now(),
        error = ${reason}
    WHERE id = ${jobId}
      AND tenant_id = ${tenantId}
      AND agent_id = ${agentId}
      AND status = 'claimed'
      AND claim_token IS NOT DISTINCT FROM ${claimToken}
      AND delivered_at IS NULL
      AND acked_at IS NULL
      AND delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
    RETURNING id
  `);
  if (requeued.rows.length > 0) return "requeued";

  const failed = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'failed',
        claim_token = NULL,
        claimed_at = NULL,
        updated_at = now(),
        error = ${`${reason} (giving up after ${MAX_DELIVERY_ATTEMPTS} delivery attempts)`}
    WHERE id = ${jobId}
      AND tenant_id = ${tenantId}
      AND agent_id = ${agentId}
      AND status = 'claimed'
      AND claim_token IS NOT DISTINCT FROM ${claimToken}
      AND delivered_at IS NULL
      AND acked_at IS NULL
      AND delivery_attempts >= ${MAX_DELIVERY_ATTEMPTS}
    RETURNING id
  `);
  if (failed.rows.length > 0) return "failed";

  return "noop";
}
