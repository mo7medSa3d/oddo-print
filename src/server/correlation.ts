import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "../lib/nanoid";
import { createHash } from "node:crypto";
type CorrelationContext = {
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

// v3: log.ts hashes claim tokens to claim_<12hex> and never emits them raw.
// This helper previously copied the raw claim token into an x-claim-id
// header. It has no callers today; hash here so a future caller on a
// response path cannot leak a live claim token.
export function withCorrelationHeaders(base: Record<string, string>, ctx: Partial<CorrelationContext>): Record<string, string> {
  const headers: Record<string, string> = { ...base };
  if (ctx.requestId) headers["x-request-id"] = ctx.requestId;
  if (ctx.jobId) headers["x-job-id"] = ctx.jobId;
  if (ctx.tenantId) headers["x-tenant-id"] = ctx.tenantId;
  if (ctx.agentId) headers["x-agent-id"] = ctx.agentId;
  if (ctx.printerId) headers["x-printer-id"] = ctx.printerId;
  if (ctx.attemptId) headers["x-attempt-id"] = ctx.attemptId;
  if (ctx.claimId) headers["x-claim-id"] = `claim_${createHash("sha256").update(ctx.claimId).digest("hex").slice(0, 12)}`;
  if (ctx.spoolerJobId) headers["x-spooler-job-id"] = ctx.spoolerJobId;
  return headers;
}
