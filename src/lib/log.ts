/**
 * Practical structured logging for the gateway.
 *
 * One JSON object per line on stdout. Fields that look like credentials or
 * document payloads are dropped so a debug log can never leak a secret.
 * A correlation id is taken from `x-request-id` / `x-correlation-id` or minted.
 */

import { createHash, randomBytes } from "node:crypto";

const SENSITIVE = /secret|password|passwd|token|authorization|cookie|api[_-]?key|payload|pairing/i;

export function redactClaimToken(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string" || !value) return undefined;
  if (/^claim_[0-9a-f]{12}$/i.test(value)) return value;
  return "claim_" + createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export type LogFields = Record<string, unknown>;

function normalizeLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 200)}…(${value.length} chars)`;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[invalid-date]" : value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => normalizeLogValue(entry, seen, depth + 1));
  const out: Record<string, unknown> = {};
  if (value instanceof Error) {
    out.name = value.name;
    out.message = normalizeLogValue(value.message, seen, depth + 1);
    if (value.stack) out.stack = normalizeLogValue(value.stack, seen, depth + 1);
    if (value.cause !== undefined) out.cause = normalizeLogValue(value.cause, seen, depth + 1);
  }
  for (const [key, nested] of Object.entries(value).slice(0, 100)) {
    if (key === "claimId" || key === "claim_id") out[key] = redactClaimToken(nested);
    else out[key] = SENSITIVE.test(key) ? "[redacted]" : normalizeLogValue(nested, seen, depth + 1);
  }
  return out;
}

export function requestIdFrom(req: Request): string {
  const existing =
    req.headers.get("x-request-id")?.trim() ||
    req.headers.get("x-correlation-id")?.trim();
  if (existing && existing.length <= 128) return existing;
  return `req_${Date.now().toString(36)}_${randomBytes(8).toString("hex")}`;
}

function sanitize(fields: LogFields): LogFields {
  return normalizeLogValue(fields) as LogFields;
}

function emit(level: "debug" | "info" | "warn" | "error", event: string, fields: LogFields): void {
  let correlation: Record<string, unknown> = {};
  try {
    // Avoid hard import cycle: correlation lives in server/, log lives in lib/
    // Use dynamic check via AsyncLocalStorage if available, otherwise skip
    const { getCorrelationContext } = require("../server/correlation") as typeof import("../server/correlation");
    const ctx = getCorrelationContext?.();
    if (ctx) {
      correlation = {
        requestId: ctx.requestId,
        tenantId: ctx.tenantId,
        jobId: ctx.jobId,
        agentId: ctx.agentId,
        printerId: ctx.printerId,
        attemptId: ctx.attemptId,
        claimId: redactClaimToken(ctx.claimId),
        spoolerJobId: ctx.spoolerJobId,
      };
      // Remove undefined
      for (const k of Object.keys(correlation)) {
        if ((correlation as any)[k] === undefined) delete (correlation as any)[k];
      }
    }
  } catch {
    // correlation unavailable in this context (e.g., tests without server)
  }
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...correlation,
    ...sanitize(fields),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else if (level === "debug") console.debug(text);
  else console.info(text);
}

export function logInfo(event: string, fields: LogFields = {}): void {
  emit("info", event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
  emit("warn", event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
  emit("error", event, fields);
}

export function logDebug(event: string, fields: LogFields = {}): void {
  emit("debug", event, fields);
}
