// CANONICAL PHYSICAL-STATUS VOCABULARY (single source of truth; the Odoo
// outbox documents the same contract on print_gateway.print_job, and the Go
// agent mirrors the markers in agent/internal/printer/outcome.go):
//
// - Job status enum is CLOSED: queued, claimed, printing, success, failed,
//   unknown, canceled (plus legacy expired). Agents may NEVER report
//   'canceled' themselves: it is an operator-only transition.
// - 'canceled' spelling is single-l by design: it matches IPP job-state
//   'canceled' (RFC 8011 value 7) and Odoo print_gateway.print_job.
// - Physical outcome metadata is CLOSED: printed, not_printed, unknown.
//   Transport-level `success` does NOT prove paper physically printed; it
//   remains `unknown` until a transport supplies explicit physical proof.
//   Any UNKNOWN marker prefix is also `unknown`; ordinary pre-dispatch
//   failures are `not_printed`.
// - Odoo maps a `failed` whose error starts with any _GATEWAY_UNKNOWN_MARKERS
//   prefix to outbox status 'unknown' (never 'failed', which would read as
//   "definitely not printed").
//
// The print-job lifecycle. The server and the Go agent must agree on this
// exact state machine (see agent/internal/agent/agent.go and
// agent/internal/printer/outcome.go, which mirror the markers below).
//
//   queued -> claimed -> printing -> success
//   queued -> canceled   OPERATOR ONLY: never claimed, never dispatched,
//                          physical outcome not_printed.
//   claimed -> canceled  OPERATOR ONLY: payload may be with the agent but the
//                          printing report has not been accepted; physical
//                          outcome stays UNKNOWN.
//   claimed -> success   the agent's terminal RE-REPORT of a durable local
//                          result under its original execution token.
//   claimed -> queued    ONLY via the agent's fenced, explicit rejection
//                          reason (AGENT_REQUEUE_REASONS).
//   (any non-terminal state) -> expired   [once expiresAt has passed]
//
// success / failed / expired / unknown / canceled are terminal: no further
// transitions are accepted once a job reaches one of them. The late
// physical-outcome override (failed/canceled -> success) is NOT part of the
// general table; it exists only via canTransition's allowLateSuccess option.
import { parseDbTimeMs } from "./database-timestamp";

const JOB_STATUSES = [
  "queued",
  "claimed",
  "printing",
  "success",
  "failed",
  "expired",
  "canceled",
  "unknown",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const PHYSICAL_OUTCOMES = ["not_printed", "printed", "unknown"] as const;
export type PhysicalOutcome = (typeof PHYSICAL_OUTCOMES)[number];

/**
 * A terminal logical failure does not necessarily mean that no paper came out.
 * These markers identify cases where execution reached an ambiguous physical
 * boundary (crash, execution timeout, expiry while printing, or delivery
 * without an execution report). Unknown/partial outcomes are terminal: they
 * are never auto-retried and never auto-failover; only a deliberate operator
 * reprint may re-issue them.
 */
export const PHYSICAL_OUTCOME_UNKNOWN_MARKERS = [
  "AGENT_EXECUTION_TIMEOUT",
  "AGENT_RESTART_DURING_PRINT",
  "JOB_EXPIRED_DURING_PRINT",
  "UNKNOWN_PARTIAL_DELIVERY",
  "UNKNOWN_SUBMISSION_OUTCOME",
] as const;

export function hasUnknownPhysicalOutcomeMarker(error: string | null | undefined): boolean {
  return PHYSICAL_OUTCOME_UNKNOWN_MARKERS.some((marker) => (error ?? "").startsWith(marker));
}

export function derivePhysicalOutcome(status: JobStatus | string, error: string | null | undefined): PhysicalOutcome {
  // v4: a canceled job is terminal and, unlike success, its outcome IS
  // decidable: queued-cancel (no UNKNOWN marker) provably never printed;
  // claimed-cancel carries UNKNOWN_PARTIAL_DELIVERY and stays unknown.
  if (status === "canceled") return hasUnknownPhysicalOutcomeMarker(error) ? "unknown" : "not_printed";
  // Fail closed for every other non-terminal state: only queued and known
  // terminal failed/expired states may be not_printed, and success never
  // proves paper output (it remains unknown until a transport supplies
  // explicit physical proof, which no current transport does).
  if (status !== "queued" && status !== "failed" && status !== "expired") return "unknown";
  if (hasUnknownPhysicalOutcomeMarker(error)) return "unknown";
  return "not_printed";
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

export const JOB_FILTER_STATUSES = [
  "all",
  "active",
  "in_flight",
  "queued",
  "claimed",
  "printing",
  "success",
  "failed",
  "expired",
  "canceled",
  "unknown",
  "attention",
  "unassigned",
] as const;

export type JobFilterStatus = (typeof JOB_FILTER_STATUSES)[number];

export function isJobFilterStatus(value: unknown): value is JobFilterStatus {
  // The shared type guard must accept only canonical values; callers normalize case first.
  // Keeping mixed-case input would incorrectly narrow it to a canonical status type.
  return typeof value === "string" && (JOB_FILTER_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: JobStatus): boolean {
  return status === "success" || status === "failed" || status === "expired" || status === "canceled" || status === "unknown";
}

// Expiration is a server-controlled terminal transition. Agents may request it
// only through the dedicated route branch, which atomically enforces expires_at
// <= NOW() plus claim fencing. It is intentionally absent from the general
// transition table so an agent cannot arbitrarily terminalize a live job.
const ALLOWED_TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set([]),
  claimed: new Set(["printing", "success", "failed", "queued"]),
  printing: new Set(["success", "failed"]),
  success: new Set([]),
  failed: new Set([]),
  expired: new Set([]),
  canceled: new Set([]),
  unknown: new Set([]),
};

export interface TransitionOptions {
  /**
   * Authorizes the one terminal override: failed/canceled -> success, when the
   * failure has eligible ambiguous-execution evidence and the original
   * agent reports success. Callers must enforce the marker, claim and age
   * fences; success does not prove physical output.
   */
  allowLateSuccess?: boolean;
}

export function canTransition(from: JobStatus, to: JobStatus, options: TransitionOptions = {}): boolean {
  if (isTerminal(from)) {
    if (options.allowLateSuccess === true && to === "success") {
      return from === "failed" || from === "canceled";
    }
    return false;
  }
  if (to === "canceled") return false;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

const LATE_SUCCESS_ERROR_MARKERS = ["AGENT_EXECUTION_TIMEOUT", "AGENT_RESTART_DURING_PRINT", "UNKNOWN_PARTIAL_DELIVERY"] as const;

/** A late success override is only meaningful while the failure is recent. */
export const LATE_SUCCESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const EXPIRED_LATE_SUCCESS_GRACE_MS = 5 * 60 * 1000;
export const LATE_SUCCESS_POST_EXPIRATION_MARKER = "LATE_SUCCESS_POST_EXPIRATION";

export interface LateSuccessCandidate {
  status: JobStatus;
  error: string | null;
  updatedAt: Date;
}

export function isLateSuccessAllowed(job: LateSuccessCandidate, nowMs: number): boolean {
  if (job.status !== "failed" && job.status !== "canceled") return false;
  const error = job.error ?? "";
  if (!LATE_SUCCESS_ERROR_MARKERS.some((marker) => error.startsWith(marker))) return false;
  const updatedAtMs = parseDbTimeMs(job.updatedAt);
  if (updatedAtMs === null) return false;
  const age = nowMs - updatedAtMs;
  return age >= 0 && age <= LATE_SUCCESS_MAX_AGE_MS;
}

interface ExpiredLateSuccessCandidate {
  status: JobStatus;
  expiresAt: Date | string;
  updatedAt: Date | string;
}

/**
 * An expired job may still be flipped to success when the agent reports the
 * job execution completed within the grace window after TTL expiry. Physical
 * paper output remains unverified unless a future transport supplies proof.
 */
export function isExpiredLateSuccessAllowed(
  job: ExpiredLateSuccessCandidate,
  nowMs: number,
): boolean {
  if (job.status !== "expired") return false;
  const expiresMs = parseDbTimeMs(job.expiresAt);
  if (expiresMs === null) return false;
  const age = nowMs - expiresMs;
  return age >= 0 && age <= EXPIRED_LATE_SUCCESS_GRACE_MS;
}

/**
 * Reasons an agent may hand a claimed job back pre-execution (the agent has
 * PROVEN it did not touch the printer). Adding a reason requires an agent-side
 * call site that can only fire before any byte reaches hardware.
 */
export const AGENT_REQUEUE_REASONS = [
  "pending_full",
  "printer_pending_full",
  "printer_not_at_desired_state",
  "printer_not_shared",
  "agent_shutting_down",
  "ledger_unavailable",
] as const;
