
import { derivePhysicalOutcome, PHYSICAL_OUTCOME_UNKNOWN_MARKERS, type PhysicalOutcome as GatewayPhysicalOutcome } from "../lib/job-status";
import { parseDbTimeMs } from "../lib/database-timestamp";
// ============================================================
// Single source of truth for operator-facing status vocabulary.
// Web console, desktop app and the Odoo screens must render the
// SAME word for the SAME state. Backend states are the gateway
// job statuses plus the derived physical outcome. Gateway and UI now
// import the same TypeScript definition; Go and Odoo are parity-tested.
// ============================================================

import { agentStaleThresholdSeconds, printerStaleThresholdSeconds, resolveAgentStaleThresholdSeconds } from "../lib/stale-threshold";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { translate } from "../i18n/translate";
import type { MessageKey } from "../i18n/messages/en";

export type Tone = "ok" | "bad" | "warn" | "info" | "neutral";

/**
 * Browser-safe UTC timestamp parser. Unlike the earlier copied implementation,
 * the canonical helper rejects invalid Date objects with null rather than NaN.
 * database-timestamp is pure and does not import PostgreSQL or Node-only code.
 */
export function parseSharedTimeMs(value: Date | string | null | undefined): number | null {
  return parseDbTimeMs(value);
}

export const UNKNOWN_OUTCOME_MARKERS = PHYSICAL_OUTCOME_UNKNOWN_MARKERS;


type JobFailureKind = "capability_mismatch" | "unsupported_transport" | "unsupported_protocol" | "ipp_unreachable" | "pdfium_headless" | "spooler_session_busy" | "interactive_virtual_timeout";

export function classifyJobFailure(error?: string | null): JobFailureKind | null {
  const value = (error ?? "").toUpperCase();
  if (UNKNOWN_OUTCOME_MARKERS.some((marker) => value.startsWith(marker))) return null;
  if (value.includes("CAPABILITY_MISMATCH")) return "capability_mismatch";
  if (value.includes("ERR_UNSUPPORTED_TRANSPORT") || value.includes("UNSUPPORTED_TRANSPORT")) return "unsupported_transport";
  if (value.includes("UNSUPPORTED_PROTOCOL") || value.includes("UNSUPPORTED PROTOCOL")) return "unsupported_protocol";
  // Both signatures are pre-dispatch failures: neither proves a job reached
  // physical hardware. Give operators actionable remedies in their locale,
  // but retain the original evidence in the durable job error/log.
  if (value.includes("IPP PRINTER ") && value.includes("UNREACHABLE (REQUEST NOT SENT)")) return "ipp_unreachable";
  if (value.includes("GETFILETYPE /DEV/STDOUT") && value.includes("HANDLE IS INVALID")) return "pdfium_headless";
  // An in-flight worker owns the Windows queue session until its actual native
  // RPC completes. Do NOT advise force-unlocking or automatic retry here.
  if (value.includes("SPOOLER SESSION LOCK") && value.includes("TIMED OUT")) return "spooler_session_busy";
  // OneNote / Microsoft Print to PDF often wait for an invisible interactive
  // dialog in Session 0; this is NOT a general PDF renderer failure.
  if ((value.includes("ONENOTE") || value.includes("MICROSOFT PRINT TO PDF")) &&
      (value.includes("CONTEXT DEADLINE EXCEEDED") || value.includes("TIMED OUT"))) return "interactive_virtual_timeout";
  return null;
}

export function jobFailurePresentation(
  error: string | null | undefined,
  locale: Locale = DEFAULT_LOCALE,
): { kind: JobFailureKind; title: string; guidance: string } | null {
  const kind = classifyJobFailure(error);
  if (kind === "capability_mismatch") {
    return {
      kind,
      title: translate(locale, "errors.capabilityMismatch"),
      guidance: translate(locale, "errors.capabilityMismatchAction"),
    };
  }
  if (kind === "unsupported_transport") {
    return {
      kind,
      title: translate(locale, "job.unsupportedTransport"),
      guidance: translate(locale, "job.unsupportedTransportAction"),
    };
  }
  if (kind === "unsupported_protocol") {
    return {
      kind,
      title: translate(locale, "job.unsupportedProtocol"),
      guidance: translate(locale, "job.unsupportedProtocolAction"),
    };
  }
  if (kind === "ipp_unreachable") {
    return {
      kind,
      title: translate(locale, "job.ippUnreachable"),
      guidance: translate(locale, "job.ippUnreachableAction"),
    };
  }
  if (kind === "pdfium_headless") {
    return {
      kind,
      title: translate(locale, "job.pdfiumHeadless"),
      guidance: translate(locale, "job.pdfiumHeadlessAction"),
    };
  }
  if (kind === "spooler_session_busy") {
    return {
      kind,
      title: translate(locale, "job.spoolerSessionBusy"),
      guidance: translate(locale, "job.spoolerSessionBusyAction"),
    };
  }
  if (kind === "interactive_virtual_timeout") {
    return {
      kind,
      title: translate(locale, "job.interactiveVirtualTimeout"),
      guidance: translate(locale, "job.interactiveVirtualTimeoutAction"),
    };
  }
  return null;
}

export type ObservationFreshness = "fresh" | "stale" | "missing";

export function sharedObservationFreshness(
  lastSeenAt: Date | string | null | undefined,
  thresholdSeconds: number,
  nowMs = Date.now(),
): ObservationFreshness {
  const seen = lastSeenAt ? parseSharedTimeMs(lastSeenAt) : null;
  if (seen === null) return "missing";
  const ageMs = nowMs - seen;
  return ageMs >= 0 && ageMs <= thresholdSeconds * 1000 ? "fresh" : "stale";
}

export function printerObservationFreshness(
  lastSeenAt: Date | string | null | undefined,
  nowMs = Date.now(),
): ObservationFreshness {
  return sharedObservationFreshness(lastSeenAt, printerStaleThresholdSeconds(), nowMs);
}

export type PhysicalOutcome = GatewayPhysicalOutcome;

/** One physical evidence rule for Gateway, dashboard and Tauri. */
export function deriveOutcome(status: string, error?: string | null): PhysicalOutcome {
  return derivePhysicalOutcome(status, error);
}

export function jobTone(status: string, outcome?: PhysicalOutcome): Tone {
  // A completed submission is informational until paper output is verified.
  // Unknown failures still need attention without inviting an automatic retry.
  if ((status.toLowerCase() === "failed" || status.toLowerCase() === "expired") && outcome === "unknown") return "warn";
  switch (status.toLowerCase()) {
    case "success":
      return outcome === "printed" ? "ok" : "info";
    case "failed":
      return "bad";
    case "expired":
      return "bad";
    case "canceled":
      return "neutral";
    case "printing":
      return "info";
    case "claimed":
      return "info";
    case "queued":
      return "neutral";
    default:
      return "neutral";
  }
}

/** Operator words for gateway job states. Never "Success" after only
 *  queueing, and never a plain "Failed" when paper may exist. */
export function jobLabel(status: string, outcome?: PhysicalOutcome, locale: Locale = DEFAULT_LOCALE): string {
  const word = (key: MessageKey) => translate(locale, key);
  switch (status.toLowerCase()) {
    case "queued":
      return word("v4.experience.job.waiting");
    case "claimed":
      return word("v4.experience.job.processing");
    case "printing":
      return word("v4.experience.job.processing");
    case "success":
      return word(outcome === "printed" ? "job.success" : "v4.experience.job.sent");
    case "failed":
      return outcome === "unknown" ? word("v4.experience.job.review") : word("v4.experience.job.failed");
    case "expired":
      return outcome === "unknown" ? word("v4.experience.job.review") : word("v4.experience.job.expired");
    case "canceled":
      // v4: both cancel variants share one operator word. The queued
      // variant is provably not printed; the claimed variant is unknown —
      // the detail view (not the badge) carries that distinction.
      return word("v4.experience.job.canceled");
    default:
      // Keep unknown internal states out of customer copy without claiming success.
      return word("v4.experience.job.unknown");
  }
}

export function jobDisplayLabel(
  status: string,
  error?: string | null,
  locale: Locale = DEFAULT_LOCALE,
  output?: { outputMedium?: unknown; outputEvidence?: unknown; submissionState?: unknown },
): string {
  // v4: canceled is its own badge, never "Failed" and never "Needs review"
  // (the claimed variant's unknown outcome is shown in job details).
  if (status === "canceled") return translate(locale, "v4.experience.job.canceled");
  // v4 (WP2): a spooler-confirmed success is labeled as such — it is
  // spooler confirmation, NOT paper proof, so it keeps the info tone
  // (see jobTone) and never the "printed" word.
  if (status === "success" && output?.submissionState === "completed") return translate(locale, "v4.experience.job.completed");
  // Unknown-outcome markers always win over any secondary failure text.
  // Specific technical failure guidance belongs in details, not status badges.
  const outcome = deriveOutcome(status, error);
  if (status === "failed" && outcome === "not_printed" &&
      /^(AGENT_DELETED|PRINTER_REMOVED): Cancelled before delivery/.test(error ?? "")) {
    return translate(locale, "v4.experience.job.canceled");
  }
  return jobLabel(status, outcome, locale);
}

/** One-sentence operator guidance for the current job state. */
export function jobGuidance(status: string, outcome: PhysicalOutcome, locale: Locale = DEFAULT_LOCALE): string {
  const word = (key: MessageKey) => translate(locale, key);
  if (status === "success") return word("job.guidance.success");
  if (status === "canceled") return word("job.guidance.canceled");
  if (status === "claimed") return word("job.guidance.claimed");
  if (status === "printing") return word("job.guidance.printing");
  if (outcome === "unknown") return word("job.guidance.unknown");
  if (status === "expired") return word("job.guidance.expired");
  if (status === "failed") return word("job.guidance.failed");
  if (status === "queued") return word("job.guidance.queued");
  return "";
}

export function printerTone(status: string): Tone {
  switch (status) {
    case "online":
      return "ok";
    case "busy":
      return "warn";
    case "error":
    case "offline":
      return "bad";
    default:
      return "neutral";
  }
}

export function printerLabel(status: string, locale: Locale = DEFAULT_LOCALE): string {
  const word = (key: MessageKey) => translate(locale, key);
  switch (status) {
    case "online":
      return word("status.online");
    case "offline":
      return word("status.offline");
    case "busy":
      return word("status.busy");
    case "error":
      return word("status.errorCheckPrinter");
    case "stale":
      return word("status.stale");
    default:
      return word("status.unknown");
  }
}



/** Heartbeat-derived truth: an agent that stopped reporting is NOT online,
 *  regardless of the last status row. Mirrors src/lib/agent-availability.ts.
 *  Prefer server-computed freshness when supplied; client wall clocks can
 *  differ from the Gateway database clock. */
export function agentLiveView(
  agent: {
    status?: string | null;
    lastSeenAt?: Date | string | null;
    lifecycle?: string | null;
    freshness?: "fresh" | "stale" | "missing" | null;
    staleThresholdSeconds?: number | null;
  },
  nowMs = Date.now(),
  locale: Locale = DEFAULT_LOCALE,
): { tone: Tone; label: string } {
  const word = (key: MessageKey) => translate(locale, key);
  if (agent.lifecycle && agent.lifecycle !== "active") {
    return {
      tone: "neutral",
      label: agent.lifecycle === "retired" ? word("status.retired") : word("status.disabled"),
    };
  }
  const hasFreshness = agent.freshness != null;
  const seen = !hasFreshness && agent.lastSeenAt ? parseSharedTimeMs(agent.lastSeenAt) : null;
  if ((hasFreshness && agent.freshness === "missing") || (!hasFreshness && seen === null)) {
    // A stored status without a heartbeat timestamp is not affirmative live
    // evidence. Keep it visibly unknown instead of manufacturing Online (or
    // Offline) from a row whose observation time cannot be established.
    return { tone: "neutral", label: word("status.unknown") };
  }
  const ageMs = seen === null ? null : nowMs - seen;
  const thresholdSeconds = agent.staleThresholdSeconds == null
    ? agentStaleThresholdSeconds()
    : resolveAgentStaleThresholdSeconds(agent.staleThresholdSeconds);
  const fresh = !hasFreshness
    ? ageMs !== null && ageMs >= 0 && ageMs <= thresholdSeconds * 1000
    : agent.freshness === "fresh";
  if (!fresh) {
    return { tone: "bad", label: word("status.heartbeatLost") };
  }
  if (agent.status === "online") return { tone: "ok", label: word("status.online") };
  if (agent.status === "offline") return { tone: "bad", label: word("status.offline") };
  return { tone: "neutral", label: word("status.unknown") };
}

/**
 * Derives the customer-facing printer state from printer evidence only. Agent
 * connectivity is rendered separately and is a distinct routing gate; losing
 * an Agent heartbeat makes printer evidence stale/unknown, never physically
 * offline by implication.
 */
export function effectivePrinterStatus(
  printer: { status?: string | null; lifecycle?: string | null; lastSeenAt?: Date | string | null },
  _agent?: { status?: string | null; lastSeenAt?: Date | string | null; lifecycle?: string | null } | null,
  nowMs = Date.now(),
): string {
  if (printer.lifecycle && printer.lifecycle !== "active") {
    return printer.lifecycle;
  }
  // Missing or unparsable observation time is not evidence of current device
  // state. This mirrors the server-side getEffectivePrinterStatus contract.
  if (!printer.lastSeenAt) return "unknown";
  const seen = parseSharedTimeMs(printer.lastSeenAt);
  if (seen === null) return "unknown";
  const ageMs = nowMs - seen;
  if (ageMs < 0 || ageMs > printerStaleThresholdSeconds() * 1000) return "unknown";
  const status = String(printer.status || "unknown").toLowerCase();
  return ["online", "offline", "busy", "error", "unknown"].includes(status) ? status : "unknown";
}
