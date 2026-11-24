// WP2 (v4, migration 0110): spooler-submission evidence — STATIC REVIEW ONLY.
//
// The Gateway DB status for an accepted physical print stays 'success'.
// 'submitted' vs 'completed' is a DERIVED presentation state, never a DB
// status and never a wire status agents send:
//   - 'submitted': the spooler/IPP endpoint accepted the job (or an old
//     agent reported 'success' with no evidence at all). Physical output
//     is unverified. This is what EVERY old-agent 'success' maps to.
//   - 'completed': a post-submission query verified spooler completion:
//     Windows JOB_STATUS_PRINTED (spooler claims the job has printed),
//     or IPP job-state completed (9) with no error reasons. This is
//     spooler confirmation, NOT paper-in-hand proof: the physical
//     outcome stays 'unknown' (see derivePhysicalOutcome) and UI copy
//     must say "spooler-confirmed", never "printed".
//   - 'unknown': verification was attempted and failed, timed out, or
//     returned an error/terminal-bad state (Windows ERROR/PAPEROUT/
//     OFFLINE/USER_INTERVENTION/BLOCKED_DEVQ/DELETED, IPP canceled (7)
//     or aborted (8)). Unknown never auto-reprints and never becomes
//     a silent success.
//
// Honesty rules enforced here (the Gateway re-derives; it never trusts
// an agent-claimed label):
//   - JOB_STATUS_COMPLETE alone ("sent to the printer, but the job may
//     not be printed yet", Microsoft Learn JOB_INFO_1) is 'submitted',
//     never 'completed'. Only PRINTED upgrades on Windows.
//   - IPP completed-with-errors (job-state-reasons containing
//     'completed-with-errors' or any 'aborted-by-system' reason) is
//     'unknown', never 'completed'.
//   - A vanished spooler job (query finds nothing after submission)
//     is 'unknown': the job may have printed and been purged, or never
//     run. Retention/purge windows make absence non-evidence.
//   - Verification timeout is 'unknown', never success, and never a
//     reprint trigger.

type SubmissionState = "submitted" | "completed" | "unknown";

interface SubmissionEvidence {
  /** Transport that accepted the job, e.g. "spooler", "ipp", "raw". */
  transport?: string;
  /** Windows spooler job id, if the transport allocated one. */
  spoolerJobId?: string;
  /** Windows JOB_INFO Status flag NAMES (not raw bits): allowlisted. */
  windowsJobStatus?: string[];
  /** Windows JOB_INFO_1 PagesPrinted, when the query returned it. */
  pagesPrinted?: number;
  /** RFC 8011 job-state value: 3 pending, 4 pending-held, 5 processing,
   *  6 processing-stopped, 7 canceled, 8 aborted, 9 completed. */
  ippJobState?: number;
  /** RFC 8011 job-state-reasons keywords, allowlisted by shape only. */
  ippJobStateReasons?: string[];
  /** Sheets the printer reports completed, when the query returned it. */
  sheetsCompleted?: number;
  /** How the agent obtained this evidence: 'query' (post-submission
   *  GetJob/Get-Job-Attributes) or 'submission' (acceptance response
   *  only — can never yield 'completed'). */
  verificationSource?: "query" | "submission";
  /** Agent-side verification attempt outcome, for audit only. The
   *  Gateway derives the state from the fields above, not this label. */
  verificationAttempt?: "completed" | "submitted" | "unknown" | "unavailable" | "timeout";
}

const WINDOWS_FLAG_ALLOWLIST = new Set([
  "PAUSED", "ERROR", "DELETING", "SPOOLING", "PRINTING", "OFFLINE",
  "PAPEROUT", "PRINTED", "DELETED", "BLOCKED_DEVQ", "USER_INTERVENTION",
  "RESTART", "COMPLETE", "RETAINED",
]);

const KEY_ALLOWLIST = new Set([
  "transport", "spoolerJobId", "windowsJobStatus", "pagesPrinted",
  "ippJobState", "ippJobStateReasons", "sheetsCompleted",
  "verificationSource", "verificationAttempt",
]);

const REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TRANSPORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * Strict validation for agent-supplied submission evidence. Unknown keys,
 * oversized arrays/strings, and out-of-range numbers are rejected (the
 * caller maps this to 400 INVALID_SUBMISSION_EVIDENCE). Null is not a
 * valid evidence value: absence of evidence is expressed by omitting
 * the field, which old agents already do.
 */
export function validateSubmissionEvidence(value: unknown): SubmissionEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length === 0 || keys.length > 9 || keys.some((k) => !KEY_ALLOWLIST.has(k))) return null;
  const out: SubmissionEvidence = {};
  if (row.transport !== undefined) {
    if (typeof row.transport !== "string" || !TRANSPORT_PATTERN.test(row.transport)) return null;
    out.transport = row.transport;
  }
  if (row.spoolerJobId !== undefined) {
    if (typeof row.spoolerJobId !== "string" || row.spoolerJobId.length < 1 || row.spoolerJobId.length > 128) return null;
    out.spoolerJobId = row.spoolerJobId;
  }
  if (row.windowsJobStatus !== undefined) {
    if (!Array.isArray(row.windowsJobStatus) || row.windowsJobStatus.length === 0 || row.windowsJobStatus.length > 8) return null;
    for (const flag of row.windowsJobStatus) {
      if (typeof flag !== "string" || !WINDOWS_FLAG_ALLOWLIST.has(flag)) return null;
    }
    out.windowsJobStatus = [...(row.windowsJobStatus as string[])];
  }
  if (row.pagesPrinted !== undefined) {
    if (typeof row.pagesPrinted !== "number" || !Number.isSafeInteger(row.pagesPrinted) || row.pagesPrinted < 0) return null;
    out.pagesPrinted = row.pagesPrinted;
  }
  if (row.ippJobState !== undefined) {
    if (typeof row.ippJobState !== "number" || !Number.isSafeInteger(row.ippJobState) || row.ippJobState < 3 || row.ippJobState > 9) return null;
    out.ippJobState = row.ippJobState;
  }
  if (row.ippJobStateReasons !== undefined) {
    if (!Array.isArray(row.ippJobStateReasons) || row.ippJobStateReasons.length > 8) return null;
    for (const reason of row.ippJobStateReasons) {
      if (typeof reason !== "string" || !REASON_PATTERN.test(reason)) return null;
    }
    out.ippJobStateReasons = [...(row.ippJobStateReasons as string[])];
  }
  if (row.sheetsCompleted !== undefined) {
    if (typeof row.sheetsCompleted !== "number" || !Number.isSafeInteger(row.sheetsCompleted) || row.sheetsCompleted < 0) return null;
    out.sheetsCompleted = row.sheetsCompleted;
  }
  if (row.verificationSource !== undefined) {
    if (row.verificationSource !== "query" && row.verificationSource !== "submission") return null;
    out.verificationSource = row.verificationSource;
  }
  if (row.verificationAttempt !== undefined) {
    if (!["completed", "submitted", "unknown", "unavailable", "timeout"].includes(String(row.verificationAttempt))) return null;
    out.verificationAttempt = row.verificationAttempt as SubmissionEvidence["verificationAttempt"];
  }
  return out;
}

/**
 * Derive the WP2 submission state. Only DB status 'success' (physical
 * medium) has a submission state; every other status yields null and
 * callers must not render a submission badge for it. File-output jobs
 * use outputOutcome instead and also yield null here.
 */
export function deriveSubmissionState(
  status: string,
  outputMedium: string | null | undefined,
  evidence: unknown,
): SubmissionState | null {
  if (status !== "success") return null;
  const parsed = validateSubmissionEvidence(evidence);
  // No evidence (old agents) or evidence from the acceptance response
  // only: accepted, unverified.
  if (!parsed || parsed.verificationSource !== "query") return "submitted";
  // An attempted query that failed, timed out, or found nothing (a
  // purged/vanished spooler job is non-evidence, not proof of no print)
  // is unknown. The agent MUST set verificationAttempt 'unknown' for
  // the vanished-job case; the Gateway does not infer it from emptiness
  // alone, because a query adapter may legitimately return only a
  // subset of fields for a job that is still present.
  if (parsed.verificationAttempt === "unknown" || parsed.verificationAttempt === "timeout") return "unknown";
  const reasons = parsed.ippJobStateReasons ?? [];
  const hasErrorReason = reasons.some((r) =>
    r === "completed-with-errors" || r.startsWith("aborted-by-system") || r === "job-canceled-at-device" || r === "job-canceled-by-user" || r === "job-canceled-by-operator",
  );
  // Terminal-bad query results downgrade to unknown, never to failed:
  // partial output may already exist, so no automatic retry is safe.
  if (parsed.ippJobState === 7 || parsed.ippJobState === 8) return "unknown";
  if (hasErrorReason) return "unknown";
  const flags = parsed.windowsJobStatus ?? [];
  if (flags.includes("ERROR") || flags.includes("PAPEROUT") || flags.includes("OFFLINE")
    || flags.includes("USER_INTERVENTION") || flags.includes("BLOCKED_DEVQ")
    || flags.includes("DELETED") || flags.includes("DELETING")) return "unknown";
  // Upgrade requires positive query evidence: Windows PRINTED, or IPP
  // completed (9) without error reasons. COMPLETE alone, PRINTING,
  // SPOOLING, pending/processing states, and a bare query with no
  // completion signal all stay 'submitted'.
  if (flags.includes("PRINTED")) return "completed";
  if (parsed.ippJobState === 9) return "completed";
  return "submitted";
}
