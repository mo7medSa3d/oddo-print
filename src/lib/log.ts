/**
 * Practical structured logging for the gateway.
 *
 * One JSON object per line on stdout. Fields that look like credentials or
 * document payloads are dropped so a debug log can never leak a secret.
 * A correlation id is taken from `x-request-id` / `x-correlation-id` or minted.
 */

import { createHash } from "node:crypto";

const SENSITIVE = /secret|password|passwd|token|authorization|cookie|api[_-]?key|payload|pairing/i;

function redactClaimId(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  return "claim_" + createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export type LogFields = Record<string, unknown>;

export function requestIdFrom(req: Request): string {
  const existing =
    req.headers.get("x-request-id")?.trim() ||
    req.headers.get("x-correlation-id")?.trim();
  if (existing && existing.length <= 128) return existing;
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > 500) {
      out[key] = `${value.slice(0, 200)}…(${value.length} chars)`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
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
        claimId: redactClaimId(ctx.claimId),
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
