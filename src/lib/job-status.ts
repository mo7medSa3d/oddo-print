// CANONICAL PHYSICAL-STATUS VOCABULARY (single source of truth; the Odoo
// outbox documents the same contract on print_gateway.print_job, and the Go
// agent mirrors the markers in agent/internal/printer/outcome.go):
//
// - Gateway DB status enum is CLOSED: queued, claimed, printing, success,
//   failed, expired, canceled (v4, migration 0109). Nothing else is ever
//   persisted (PostgreSQL CHECK) and nothing else is accepted on the agent
//   API (isJobStatus) except that agents may NEVER report 'canceled'
//   themselves: it is an operator-only transition applied by the cancel
//   route's conditional UPDATE, never via canTransition.
// - 'canceled' spelling is single-l by design: it matches the existing
//   JOB_CANCELED_BY_OPERATOR marker, IPP job-state 'canceled' (RFC 8011
//   value 7), and the v4 brief. Discovery sessions use 'cancelled'
//   (schema.ts discoverySessions) for a DIFFERENT entity and are untouched;
//   the two spellings must never be unified by a search-replace.
// - Physical outcome metadata is CLOSED: printed, not_printed, unknown.
//   Transport-level `success` does NOT prove paper physically printed; it
//   remains `unknown` until a transport supplies explicit physical proof.
//   Any UNKNOWN marker prefix is also `unknown`; ordinary pre-dispatch
//   failures are `not_printed`.
// - Odoo maps a Gateway `failed` whose error starts with any
//   _GATEWAY_UNKNOWN_MARKERS prefix to outbox status 'unknown' (never
//   'failed', which would read as "definitely not printed").
//
// The print-job lifecycle. The server and the Go agent must agree on this
// exact state machine (see agent/internal/agent/agent.go and
// agent/internal/printer/outcome.go, which mirror the markers below).
//
//   queued -> claimed -> printing -> success
//   queued -> canceled   OPERATOR ONLY (cancel route): never claimed,
//                          never dispatched, physical outcome not_printed,
//                          admission credit refunded (see entitlements).
//   claimed -> canceled  OPERATOR ONLY (cancel route): payload may be with
//                          the agent but the printing report has not been
//                          accepted, so no hardware byte was authorized;
//                          physical outcome stays UNKNOWN (the agent may
//                          already hold a durable executed result it has
//                          not re-reported yet). Claim token PRESERVED for
//                          the 24h late-success reconciliation window, then
//                          cleared by the maintenance sweep. Never refunded.
//   (any non-terminal state) -> expired   [once expiresAt has passed]
//   claimed -> success  the agent's terminal RE-REPORT of a durable local
//                     result: the document was already executed by this agent
//                     and the stored outcome is reported under its original
//                     execution token instead of printing a second time (duplicate
//                     delivery, or a printing report that never landed)
//   claimed -> queued   ONLY via the agent's fenced, explicit rejection
//                     reason (AGENT_REQUEUE_REASONS: the agent received the
//                     job but provably did not touch the printer; the claim
//                     token authenticates the claim)
//   (any non-terminal state) -> expired   [once expiresAt has passed]
//
// success / failed / expired are terminal: no further transitions are
// accepted once a job reaches one of them. The late physical-outcome
// override (failed -> success) is NOT part of the general table; it exists
// only as an explicitly authorized code path via canTransition's
// allowLateSuccess option; the HTTP route fences its age atomically against PostgreSQL time.
import { parseDbTimeMs } from "./database-timestamp";

const JOB_STATUSES = [
  "queued",
  "claimed",
  "printing",
  "success",
  "failed",
  "expired",
  "canceled",
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
  return status === "success" || status === "failed" || status === "expired" || status === "canceled";
}

// Expiration is a server-controlled terminal transition. Agents may request it
// only through the dedicated route branch, which atomically enforces expires_at
// <= NOW() plus claim fencing. It is intentionally absent from the general
// transition table so an agent cannot arbitrarily terminalize a live job.
const ALLOWED_TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set([]),
  // claimed -> queued is the agent's explicit fenced rejection path (see the
  // header). It is never a general re-queueing capability.
  //
  // claimed -> success is the agent's TERMINAL RE-REPORT on a live claim. The
  // agent never re-prints a job whose durable local ledger already holds a
  // terminal result; it re-reports that stored result under its original
  // execution token instead (agent/internal/agent/agent.go: "already completed locally
  // (success). Re-reporting terminal result instead of printing again."). That
  // path returns BEFORE the printing report, so the Gateway row is still
  // 'claimed' when the same attempt remains live and its printing report did
  // not land. A newer claim cannot authenticate the old result. This is the same
  // execution attempt claimed -> printing -> success describes, reported in one
  // step; the claim-token fence (fencedJobWrite) still proves ownership,
  // and success stamps delivery evidence, so no new authority is granted:
  // the token owner could already reach success through the two-step path.
  // Rejecting it would sweep a submitted job into failed/unknown.
  claimed: new Set(["printing", "success", "failed", "queued"]),
  printing: new Set(["success", "failed"]),
  // Terminal states have NO outgoing transitions in the general table.
  // The failed -> success late physical-outcome override is an explicitly
  // authorized exception passed in via options, never a default.
  // v4: the same narrow exception covers canceled -> success, but ONLY
  // for claimed-cancels (UNKNOWN_PARTIAL_DELIVERY marker, live claim
  // token, 24h window): the agent may have executed before the cancel
  // landed and its terminal re-report is the only reconciliation path.
  // Queued-cancels (token NULL, no marker) can never late-succeed.
  success: new Set([]),
  failed: new Set([]),
  expired: new Set([]),
  canceled: new Set([]),
};

export interface TransitionOptions {
  /**
   * Authorizes the one terminal override: failed -> success, when the
   * failure has eligible ambiguous-execution evidence and the original
   * agent reports success. Callers must enforce the marker, claim and age
   * fences; success does not prove physical output.
   */
  allowLateSuccess?: boolean;
}

export function canTransition(from: JobStatus, to: JobStatus, options: TransitionOptions = {}): boolean {
  if (isTerminal(from)) {
    if (options.allowLateSuccess === true && to === "success") {
      // v4: failed (existing) or claimed-cancel (UNKNOWN marker, live token;
      // the agent route re-asserts marker, token and age in SQL).
      return from === "failed" || from === "canceled";
    }
    return false;
  }
  // Agents may never report 'canceled': it is operator-only. The cancel
  // route bypasses this table with its own conditional UPDATE, exactly as
  // the v3 route bypassed it for failed.
  if (to === "canceled") return false;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Errors that mark a failure as "the gateway gave up waiting for the
 * physical print" — as opposed to a real print failure (connection
 * refused, capability mismatch, ...). Only these may be overridden by a
 * late agent success report.
 * UNKNOWN_PARTIAL_DELIVERY belongs here too: the terminal write retains
 * the claim token for these markers, so an agent-reported unknown failure
 * stays late-success-eligible exactly like a sweeper-created one (the
 * late-success gate requires a live token for UNKNOWN rows). The 24h
 * token-clear sweep still bounds the window.
 */
export const LATE_SUCCESS_ERROR_MARKERS = ["AGENT_EXECUTION_TIMEOUT", "AGENT_RESTART_DURING_PRINT", "UNKNOWN_PARTIAL_DELIVERY"] as const;

/** Operator-cancel marker for a queued job that provably never printed. */
export const JOB_CANCELED_BY_OPERATOR = "JOB_CANCELED_BY_OPERATOR" as const;
/** Wire code returned when a write targets an already-canceled job. */
export const JOB_ALREADY_CANCELED = "JOB_ALREADY_CANCELED" as const;

/** A late success override is only meaningful while the failure is recent. */
export const LATE_SUCCESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Physical grace window for prints that completed right at the TTL
 * boundary. An agent reporting successful execution on a recently expired
 * job (expiry within this window) is recorded as success with physical output
 * still unverified instead of a blind 409 Conflict.
 */
export const EXPIRED_LATE_SUCCESS_GRACE_MS = 5 * 60 * 1000;
export const LATE_SUCCESS_POST_EXPIRATION_MARKER = "LATE_SUCCESS_POST_EXPIRATION";

export interface LateSuccessCandidate {
  status: JobStatus;
  error: string | null;
  updatedAt: Date;
}

export function isLateSuccessAllowed(job: LateSuccessCandidate, nowMs: number): boolean {
  // v4: failed (existing) plus claimed-cancel: a canceled row is only
  // late-success-eligible when it carries the UNKNOWN_PARTIAL_DELIVERY
  // marker (claimed-cancel); queued-cancels carry JOB_CANCELED_BY_OPERATOR
  // and are excluded by the marker check below.
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
 * The window is measured from the database TTL (expiresAt), not from when
 * the sweeper happened to terminalize the row.
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
 * PROVEN it did not touch the printer): executor saturation, shutdown, or an
 * unwritable local durable ledger (the agent's evidence base for whether a
 * job printed). Adding a reason requires an agent-side call site that can
 * only fire before any byte reaches hardware.
 */
export const AGENT_REQUEUE_REASONS = [
  "pending_full",
  "printer_pending_full",
  "printer_not_at_desired_state",
  "printer_not_shared",
  "agent_shutting_down",
  "ledger_unavailable",
] as const;

// Proven zero-byte hand-back waits for fresh explicit owner permission; it is
// never a physical UNKNOWN marker and must not spin a delivery/retry loop.
export const PRINTER_NOT_SHARED_PAUSE = "Agent returned job before execution (printer_not_shared)";

// Deprecated legacy reason retained to recognize and refuse older Agents.
// It never authorizes printing -> queued: the prior physical outcome is unknown.
// A deliberate new operation after reconciliation must use a new identity.
export const AGENT_REPRINT_AFTER_CRASH_REASON = "agent_reprint_after_crash" as const;
