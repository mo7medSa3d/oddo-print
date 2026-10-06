import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { jobEvents, printJobs, printJobReceipts } from "../../../../../db/schema";
import { validateWorkspaceManager } from "../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { and, eq } from "drizzle-orm";
import { getJobTimeline } from "../../../../../lib/job-timeline";
import { runWithCorrelation, generateRequestId } from "../../../../../server/correlation";
import { requestIdFrom, logWarn, redactClaimToken } from "../../../../../lib/log";

export const dynamic = "force-dynamic";

type JobRow = typeof printJobs.$inferSelect;
type JobEventRow = typeof jobEvents.$inferSelect;
type TimelineEntry = {
  id: string;
  stage: string;
  status: string;
  at?: Date | null;
  message?: string | null;
  /** Translation key for the detail line; absent for persisted audit text. */
  messageKey?: string | null;
  messageVars?: Record<string, string | number> | null;
  errorCode?: string | null;
  attemptId?: string | null;
  claimId?: string | null;
  spoolerJobId?: string | null;
  agentId?: string | null;
  printerId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await validateWorkspaceManager(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(auth, "jobs.read"); } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = auth.tenantId;

  const requestId = requestIdFrom(req) || generateRequestId();
  const correlation = { requestId, tenantId, jobId: id };

  return runWithCorrelation(correlation, async () => {
    const rows = await db.select().from(printJobs).where(and(eq(printJobs.tenantId, tenantId), eq(printJobs.id, id))).limit(1);
    if (rows.length === 0) {
      const receipt = await db.query.printJobReceipts.findFirst({ where: and(eq(printJobReceipts.tenantId, tenantId), eq(printJobReceipts.id, id)) });
      if (receipt) return NextResponse.json({ jobId: id, tenantId, status: receipt.status, archived: true,
        timeline: [],
        evidence: {
          source: "archived_receipt",
          recordedEventCount: 0,
          job: {
            status: receipt.status,
            createdAt: receipt.createdAt,
            updatedAt: receipt.updatedAt,
            agentId: receipt.agentId,
            printerId: receipt.printerId,
          },
        },
        correlation: { requestId, jobId: id, tenantId, agentId: receipt.agentId, printerId: receipt.printerId },
      }, { headers: { "x-request-id": requestId } });
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "x-request-id": requestId } });
    }
    const job: JobRow = rows[0];

    let events: JobEventRow[] = [];
    try {
      events = await getJobTimeline(tenantId, id);
    } catch (error) {
      // The job-row fallback is intentional degraded mode, but the database
      // failure must remain observable instead of looking like an empty timeline.
      logWarn("job.timeline_lookup_failed", { requestId, tenantId, jobId: id, error: error instanceof Error ? error.message : "unknown" });
      events = [];
    }

    const timeline: TimelineEntry[] = events.map((e: JobEventRow) => ({
      id: e.id,
      stage: e.stage,
      status: e.status,
      at: e.createdAt,
      message: e.message,
      errorCode: e.errorCode,
      attemptId: e.attemptId,
      claimId: redactClaimToken(e.claimId),
      spoolerJobId: e.spoolerJobId,
      agentId: e.agentId,
      printerId: e.printerId,
      requestId: e.requestId,
      metadata: e.metadata,
    }));

    const res = NextResponse.json(
      {
        jobId: id,
        tenantId,
        status: job.status,
        spoolerJobId: job.spoolerJobId,
        attemptId: job.attemptId,
        timeline,
        evidence: {
          source: timeline.length > 0 ? "persisted_events" : "job_record_only",
          recordedEventCount: timeline.length,
          job: {
            status: job.status,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            claimedAt: job.claimedAt,
            deliveredAt: job.deliveredAt,
            ackedAt: job.ackedAt,
            expiresAt: job.expiresAt,
            error: job.error,
            deliveryAttempts: job.deliveryAttempts,
            retries: job.retries,
            attemptId: job.attemptId,
            spoolerJobId: job.spoolerJobId,
          },
        },
        correlation: {
          requestId,
          jobId: id,
          tenantId,
          agentId: job.agentId,
          printerId: job.printerId,
          attemptId: job.attemptId,
          // Redacted claimId — never raw token
          claimId: redactClaimToken(job.claimToken),
          spoolerJobId: job.spoolerJobId,
        },
      },
      { headers: { "x-request-id": requestId } }
    );
    return res;
  });
}
