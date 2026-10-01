/**
 * Practical structured logging for the gateway.
 *
 * One JSON object per line on stdout. Fields that look like credentials or
 * document payloads are dropped so a debug log can never leak a secret.
 * A correlation id is taken from `x-request-id` / `x-correlation-id` or minted.
 */

import { createHash, randomBytes } from "node:crypto";

const SENSITIVE = /secret|password|passwd|token|authorization|cookie|api[_-]?key|payload|pairing/i;

export function redactClaimToken(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  if (/^claim_[0-9a-f]{12}$/i.test(value)) return value;
  return "claim_" + createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export type LogFields = Record<string, unknown>;

function normalizeLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    if (value.stack) out.stack = value.stack;
    const cause = (value as Error & { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = normalizeLogValue(cause, seen);
    for (const [key, nested] of Object.entries(value)) {
      if (!(key in out)) out[key] = normalizeLogValue(nested, seen);
    }
    return out;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeLogValue(entry, seen));
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = normalizeLogValue(nested, seen);
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
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "claimId" || key === "claim_id") {
      out[key] = redactClaimToken(value);
      continue;
    }
    if (SENSITIVE.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > 500) {
      out[key] = `${value.slice(0, 200)}…(${value.length} chars)`;
      continue;
    }
    out[key] = normalizeLogValue(value);
  }
  return out;
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
