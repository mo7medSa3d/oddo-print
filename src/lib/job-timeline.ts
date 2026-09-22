import { db, queryWithTimeout } from "../db/client";
import { jobEvents, printJobs } from "../db/schema";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "./nanoid";
import { getCorrelationContext } from "../server/correlation";
import { logInfo } from "./log";

export type JobTimelineStage =
  | "created"
  | "queued"
  | "claimed"
  | "accepted"
  | "connection"
  | "printing"
  | "delivery"
  | "success"
  | "failed"
  | "expired"
  | "blocked";

export type JobTimelineStatus = "ok" | "error" | "blocked" | "pending";

export interface RecordJobEventInput {
  jobId: string;
  tenantId: string;
  stage: JobTimelineStage;
  status: JobTimelineStatus;
  message?: string;
  errorCode?: string;
  attemptId?: string;
  claimId?: string;
  spoolerJobId?: string;
  agentId?: string;
  printerId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordJobEvent(input: RecordJobEventInput): Promise<void> {
  const ctx = getCorrelationContext();
  const event = {
    id: `evt_${nanoid(16)}`,
    jobId: input.jobId,
    tenantId: input.tenantId,
    stage: input.stage,
    status: input.status,
    attemptId: input.attemptId ?? ctx?.attemptId,
    claimId: input.claimId ?? ctx?.claimId,
    spoolerJobId: input.spoolerJobId ?? ctx?.spoolerJobId,
    agentId: input.agentId ?? ctx?.agentId,
    printerId: input.printerId ?? ctx?.printerId,
    requestId: input.requestId ?? ctx?.requestId,
    message: input.message,
    errorCode: input.errorCode,
    metadata: input.metadata ?? {},
  };
  try {
    await queryWithTimeout(
      db.insert(jobEvents).values(event as any),
      3000,
      "recordJobEvent"
    );
    logInfo("job_timeline_event", { jobId: input.jobId, stage: input.stage, status: input.status });
  } catch (e) {
    // Timeline must never break main flow
    logInfo("job_timeline_event_failed", { jobId: input.jobId, stage: input.stage, error: String(e).slice(0, 200) });
  }
}

export async function getJobTimeline(tenantId: string, jobId: string) {
  const events = await queryWithTimeout(
    db.select().from(jobEvents).where(and(eq(jobEvents.tenantId, tenantId), eq(jobEvents.jobId, jobId))).orderBy(jobEvents.createdAt),
    3000,
    "getJobTimeline"
  );
  return events;
}

export function buildTimelineFromJobRow(job: any): { stage: JobTimelineStage; status: JobTimelineStatus; at?: Date; message?: string }[] {
  const timeline: { stage: JobTimelineStage; status: JobTimelineStatus; at?: Date; message?: string }[] = [];
  if (job.createdAt) timeline.push({ stage: "created", status: "ok", at: job.createdAt, message: "Job created in Gateway" });
  if (job.status === "queued" || job.claimedAt || job.deliveredAt || job.ackedAt) {
    timeline.push({ stage: "queued", status: "ok", at: job.createdAt, message: `Queued for agent ${job.agentId}` });
  }
  if (job.claimedAt) {
    timeline.push({ stage: "claimed", status: "ok", at: job.claimedAt, message: `Claimed by agent (attempt ${job.attemptId ?? job.deliveryAttempts ?? 1})` });
  }
  if (job.status === "printing" || job.deliveredAt) {
    timeline.push({ stage: "accepted", status: "ok", at: job.deliveredAt ?? job.claimedAt, message: "Agent accepted job" });
  }
  if (job.spoolerJobId) {
    timeline.push({ stage: "connection", status: "ok", message: `Linked to Windows Spooler Job ID ${job.spoolerJobId}` });
  }
  if (job.status === "printing") {
    timeline.push({ stage: "printing", status: "pending", at: job.deliveredAt, message: "Printing in progress" });
  }
  if (job.status === "success") {
    timeline.push({ stage: "delivery", status: "ok", at: job.ackedAt, message: "Delivered to printer transport" });
    timeline.push({ stage: "success", status: "ok", at: job.ackedAt, message: "Gateway delivery completed; physical paper output is not independently verified" });
  }
  if (job.status === "failed") {
    timeline.push({ stage: "failed", status: "error", at: job.updatedAt, message: job.error ?? "Failed" });
  }
  if (job.status === "expired") {
    timeline.push({ stage: "expired", status: "error", at: job.updatedAt, message: "Job expired before delivery" });
  }
  return timeline;
}
