import { db, queryWithTimeout } from "../db/client";
import { jobEvents, printJobs } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "./nanoid";
import { getCorrelationContext } from "../server/correlation";
import { logInfo, redactClaimToken } from "./log";

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
    // `claimId` may be the live claim token. Persist only an irreversible
    // opaque identifier; the raw bearer credential must never enter timeline storage.
    claimId: redactClaimToken(input.claimId ?? ctx?.claimId),
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
      () => db.insert(jobEvents).values(event),
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
    () => db.select().from(jobEvents).where(and(eq(jobEvents.tenantId, tenantId), eq(jobEvents.jobId, jobId))).orderBy(jobEvents.createdAt),
    3000,
    "getJobTimeline"
  );
  return events;
}

export type TimelineMessageKey = string;

export type DerivedTimelineEntry = {
  stage: JobTimelineStage;
  status: JobTimelineStatus;
  at?: Date | null;
  /**
   * Translation key for the detail line.
   *
   * The timeline is rendered in the operator's language, so the generator
   * emits a key plus its variables rather than a finished English sentence.
   * Persisted `job_events.message` stays raw — it is audit text written by
   * the server, and the client falls back to it only when no key exists.
   */
  messageKey?: TimelineMessageKey;
  messageVars?: Record<string, string | number>;
  message?: string;
};

export function buildTimelineFromJobRow(job: typeof printJobs.$inferSelect): DerivedTimelineEntry[] {
  const timeline: DerivedTimelineEntry[] = [];
  if (job.createdAt) {
    timeline.push({ stage: "created", status: "ok", at: job.createdAt, messageKey: "job.timeline.created" });
  }
  if (job.status === "queued" || job.claimedAt || job.deliveredAt || job.ackedAt) {
    timeline.push({ stage: "queued", status: "ok", at: job.createdAt, messageKey: "job.timeline.queuedFor", messageVars: { agent: job.agentId ?? "" } });
  }
  if (job.claimedAt) {
    timeline.push({ stage: "claimed", status: "ok", at: job.claimedAt, messageKey: "job.timeline.claimedAttempt", messageVars: { attempt: job.attemptId ?? job.deliveryAttempts ?? 1 } });
  }
  if (job.status === "printing" || job.deliveredAt) {
    timeline.push({ stage: "accepted", status: "ok", at: job.deliveredAt ?? job.claimedAt, messageKey: "job.timeline.accepted" });
  }
  if (job.spoolerJobId) {
    timeline.push({ stage: "connection", status: "ok", messageKey: "job.timeline.spoolerLink", messageVars: { id: job.spoolerJobId } });
  }
  if (job.status === "printing") {
    timeline.push({ stage: "printing", status: "pending", at: job.deliveredAt, messageKey: "job.timeline.printing" });
  }
  if (job.status === "success") {
    timeline.push({ stage: "delivery", status: "ok", at: job.ackedAt, messageKey: "job.timeline.delivered" });
    timeline.push({ stage: "success", status: "ok", at: job.ackedAt, messageKey: "job.timeline.successUnverified" });
  }
  if (job.status === "failed") {
    timeline.push({
      stage: "failed",
      status: "error",
      at: job.updatedAt,
      messageKey: job.error ? "job.timeline.failedWithDetail" : "job.timeline.failed",
      messageVars: job.error ? { detail: job.error } : undefined,
    });
  }
  if (job.status === "expired") {
    timeline.push({ stage: "expired", status: "error", at: job.updatedAt, messageKey: "job.timeline.expired" });
  }
  return timeline;
}
