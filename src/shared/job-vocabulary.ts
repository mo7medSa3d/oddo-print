// ============================================================
// Single source of truth for operator-facing status vocabulary.
// Web console, desktop app and the Odoo screens must render the
// SAME word for the SAME state. Backend states are the gateway
// job statuses plus the derived physical outcome; the markers
// below MUST stay in lockstep with PHYSICAL_OUTCOME_UNKNOWN_MARKERS
// in src/lib/job-status.ts (a unit test locks both lists).
// ============================================================

import { agentStaleThresholdSeconds, printerStaleThresholdSeconds, resolveAgentStaleThresholdSeconds } from "../lib/stale-threshold";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { translate } from "../i18n/translate";
import type { MessageKey } from "../i18n/messages/en";

export type Tone = "ok" | "bad" | "warn" | "info" | "neutral";

/**
 * Client-safe timestamp normalization. This module ships in browser/desktop
 * bundles, so it cannot import parseDbTimeMs from lib/database-clock (which
 * pulls in the pg chain). The naive-string branch mirrors it exactly:
 * node-postgres raw rows emit naive "YYYY-MM-DD HH:MM:SS" in UTC, and
 * new Date(str) would parse those as host-local time.
 */
export function parseSharedTimeMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const text = value.trim();
  if (!text) return null;
  let iso = text.replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) {
    iso += /[+-]\d{2}$/.test(iso) ? ":00" : "Z";
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export const UNKNOWN_OUTCOME_MARKERS = [
  "AGENT_EXECUTION_TIMEOUT",
  "AGENT_RESTART_DURING_PRINT",
  "JOB_EXPIRED_DURING_PRINT",
  "UNKNOWN_PARTIAL_DELIVERY",
  "UNKNOWN_SUBMISSION_OUTCOME",
] as const;


export type JobFailureKind = "capability_mismatch" | "unsupported_transport" | "unsupported_protocol" | "ipp_unreachable" | "pdfium_headless";

export function classifyJobFailure(error?: string | null): JobFailureKind | null {
  const value = (error ?? "").toUpperCase();
  if (value.includes("CAPABILITY_MISMATCH")) return "capability_mismatch";
  if (value.includes("ERR_UNSUPPORTED_TRANSPORT") || value.includes("UNSUPPORTED_TRANSPORT")) return "unsupported_transport";
  if (value.includes("UNSUPPORTED_PROTOCOL") || value.includes("UNSUPPORTED PROTOCOL")) return "unsupported_protocol";
  // Both signatures are pre-dispatch failures: neither proves a job reached
  // physical hardware. Give operators actionable remedies in their locale,
  // but retain the original evidence in the durable job error/log.
  if (value.includes("IPP PRINTER ") && value.includes("UNREACHABLE (REQUEST NOT SENT)")) return "ipp_unreachable";
  if (value.includes("GETFILETYPE /DEV/STDOUT") && value.includes("HANDLE IS INVALID")) return "pdfium_headless";
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

export function agentHeartbeatFreshness(
  lastSeenAt: Date | string | null | undefined,
  nowMs = Date.now(),
  staleThresholdSeconds?: number | null,
): ObservationFreshness {
  return sharedObservationFreshness(
    lastSeenAt,
    staleThresholdSeconds == null
      ? agentStaleThresholdSeconds()
      : resolveAgentStaleThresholdSeconds(staleThresholdSeconds),
    nowMs,
  );
}

export type PhysicalOutcome = "printed" | "not_printed" | "unknown";

/** Client-side mirror of derivePhysicalOutcome (src/lib/job-status.ts).
 * In-flight rows (claimed/printing) are "not_printed": no paper evidence
 * exists yet. The job STATUS already conveys in-flight; the outcome must not
 * invent a fourth state the server never emits. */
export function deriveOutcome(status: string, error?: string | null): PhysicalOutcome {
  // Successful transport/execution is not proof of physical paper output.
  // Keep the physical result unverified until a real hardware proof exists.
  if (status === "success") return "unknown";
  const msg = error ?? "";
  if (UNKNOWN_OUTCOME_MARKERS.some((marker) => msg.startsWith(marker))) return "unknown";
  return "not_printed";
}

export function jobTone(status: string, outcome?: PhysicalOutcome): Tone {
  // A terminal transport success is healthy even when its physical outcome
  // is unverified. Only genuinely ambiguous failure/expiry states need the
  // attention tone.
  if (status.toLowerCase() !== "success" && outcome === "unknown") return "warn";
  switch (status.toLowerCase()) {
    case "success":
      return "ok";
    case "failed":
      return "bad";
    case "expired":
      return "bad";
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
      return word("job.queued");
    case "claimed":
      return word("job.claimed");
    case "printing":
      return word("job.printing");
    case "success":
      return word("job.success");
    case "failed":
      return outcome === "unknown" ? word("job.failedUnknown") : word("job.failed");
    case "expired":
      return outcome === "unknown" ? word("job.expiredUnknown") : word("job.expired");
    default:
      // An unrecognised backend state is shown verbatim: inventing a friendly
      // word for a state we do not model would misreport the job.
      return status;
  }
}

export function jobDisplayLabel(
  status: string,
  error?: string | null,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const failure = status.toLowerCase() === "failed" ? jobFailurePresentation(error, locale) : null;
  return failure?.title ?? jobLabel(status, deriveOutcome(status, error), locale);
}

/** One-sentence operator guidance for the current job state. */
export function jobGuidance(status: string, outcome: PhysicalOutcome, locale: Locale = DEFAULT_LOCALE): string {
  const word = (key: MessageKey) => translate(locale, key);
  if (status === "success") return word("job.guidance.success");
  if (outcome === "unknown") return word("job.guidance.unknown");
  if (status === "expired") return word("job.guidance.expired");
  if (status === "failed") return word("job.guidance.failed");
  if (status === "queued") return word("job.guidance.queued");
  if (status === "claimed") return word("job.guidance.claimed");
  if (status === "printing") return word("job.guidance.printing");
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
 *  Browser/desktop callers receive the configured Gateway threshold with the
 *  Agent record so the UI and claim gate cannot drift when the deployment
 *  overrides STALE_AGENT_THRESHOLD_SECONDS. */
export function agentLiveView(
  agent: {
    status?: string | null;
    lastSeenAt?: Date | string | null;
    lifecycle?: string | null;
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
  const seen = agent.lastSeenAt ? parseSharedTimeMs(agent.lastSeenAt) : null;
  if (seen === null) {
    // A stored status without a heartbeat timestamp is not affirmative live
    // evidence. Keep it visibly unknown instead of manufacturing Online (or
    // Offline) from a row whose observation time cannot be established.
    return { tone: "neutral", label: word("status.unknown") };
  }
  const ageMs = nowMs - seen;
  const thresholdSeconds = agent.staleThresholdSeconds == null
    ? agentStaleThresholdSeconds()
    : resolveAgentStaleThresholdSeconds(agent.staleThresholdSeconds);
  const fresh = ageMs >= 0 && ageMs <= thresholdSeconds * 1000;
  if (!fresh) {
    return { tone: "bad", label: word("status.heartbeatLost") };
  }
  if (agent.status === "online") return { tone: "ok", label: word("status.online") };
  return { tone: "bad", label: word("status.offline") };
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
