/**
 * Distributed tracing helpers — correlation IDs across Odoo → Gateway → Queue → Agent → Printer
 * OpenTelemetry-inspired but lightweight: structured logs with correlation IDs, no external dependency required for now.
 * 
 * Correlation IDs:
 * - request_id: per HTTP request, generated if missing X-Request-Id, propagated via header
 * - job_id: print job id
 * - tenant_id: tenant
 * - agent_id: agent
 * - printer_id: printer
 * - attempt_id: delivery attempt
 * - claim_id: claim token / claim id
 * - spooler_job_id: Windows spooler job id (when using spooler transport)
 */

import { getCorrelationContext, generateRequestId, generateAttemptId, generateClaimId } from "../server/correlation";
import { logInfo, logWarn, logError } from "./log";

export type TraceContext = {
  requestId: string;
  jobId?: string;
  tenantId?: string;
  agentId?: string;
  printerId?: string;
  attemptId?: string;
  claimId?: string;
  spoolerJobId?: string;
};

export function currentTrace(): TraceContext | undefined {
  const ctx = getCorrelationContext();
  if (!ctx) return undefined;
  return {
    requestId: ctx.requestId,
    jobId: ctx.jobId,
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    printerId: ctx.printerId,
    attemptId: ctx.attemptId,
    claimId: ctx.claimId,
    spoolerJobId: ctx.spoolerJobId,
  };
}

export function traceInfo(event: string, extra: Record<string, unknown> = {}): void {
  const ctx = currentTrace();
  logInfo(event, { ...ctx, ...extra });
}

export function traceWarn(event: string, extra: Record<string, unknown> = {}): void {
  const ctx = currentTrace();
  logWarn(event, { ...ctx, ...extra });
}

export function traceError(event: string, extra: Record<string, unknown> = {}): void {
  const ctx = currentTrace();
  logError(event, { ...ctx, ...extra });
}

export function buildTraceHeaders(ctx: Partial<TraceContext>): Record<string, string> {
  const headers: Record<string, string> = {};
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

export function newRequestTrace(existingRequestId?: string): TraceContext {
  return {
    requestId: existingRequestId && existingRequestId.length <= 128 ? existingRequestId : generateRequestId(),
    attemptId: generateAttemptId(),
  };
}

export function newClaimTrace(jobId: string, tenantId: string, agentId: string, printerId: string, claimToken: string): TraceContext {
  const ctx = getCorrelationContext();
  return {
    requestId: ctx?.requestId ?? generateRequestId(),
    jobId,
    tenantId,
    agentId,
    printerId,
    claimId: claimToken || generateClaimId(),
    attemptId: generateAttemptId(),
  };
}
