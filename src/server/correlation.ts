import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "../lib/nanoid";

export type CorrelationContext = {
  requestId: string;
  tenantId?: string;
  jobId?: string;
  agentId?: string;
  printerId?: string;
  attemptId?: string;
  claimId?: string;
  spoolerJobId?: string;
};

const storage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function generateRequestId(): string {
  return `req_${nanoid(12)}`;
}

export function generateAttemptId(): string {
  return `attempt_${nanoid(10)}`;
}

export function generateClaimId(): string {
  return `claim_${nanoid(10)}`;
}

export function extractRequestIdFromHeaders(headers: Headers | Record<string, string | undefined>): string | null {
  if (headers instanceof Headers) {
    return headers.get("x-request-id")?.trim() || headers.get("x-correlation-id")?.trim() || null;
  }
  return (headers["x-request-id"]?.trim() || headers["x-correlation-id"]?.trim() || null) as string | null;
}

export function ensureRequestId(headers: Headers): string {
  const existing = headers.get("x-request-id")?.trim() || headers.get("x-correlation-id")?.trim();
  if (existing && existing.length > 0 && existing.length <= 128) return existing;
  const generated = generateRequestId();
  headers.set("x-request-id", generated);
  return generated;
}

export function withCorrelationHeaders(base: Record<string, string>, ctx: Partial<CorrelationContext>): Record<string, string> {
  const headers: Record<string, string> = { ...base };
  if (ctx.requestId) headers["x-request-id"] = ctx.requestId;
  if (ctx.jobId) headers["x-job-id"] = ctx.jobId;
  if (ctx.tenantId) headers["x-tenant-id"] = ctx.tenantId;
  if (ctx.agentId) headers["x-agent-id"] = ctx.agentId;
  if (ctx.printerId) headers["x-printer-id"] = ctx.printerId;
  if (ctx.attemptId) headers["x-attempt-id"] = ctx.attemptId;
  if (ctx.claimId) headers["x-claim-id"] = ctx.claimId;
  if (ctx.spoolerJobId) headers["x-spooler-job-id"] = ctx.spoolerJobId;
  return headers;
}
