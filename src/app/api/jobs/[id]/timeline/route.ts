import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { jobEvents, printJobs } from "../../../../../db/schema";
import { validateWorkspaceManager } from "../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { and, eq } from "drizzle-orm";
import { getJobTimeline, buildTimelineFromJobRow } from "../../../../../lib/job-timeline";
import { runWithCorrelation, generateRequestId } from "../../../../../server/correlation";
import { requestIdFrom, logWarn } from "../../../../../lib/log";
import { createHash } from "crypto";

export const dynamic = "force-dynamic";

type JobRow = typeof printJobs.$inferSelect;
type JobEventRow = typeof jobEvents.$inferSelect;
type TimelineEntry = {
  id: string;
  stage: string;
  status: string;
  at?: Date | null;
  message?: string | null;
  errorCode?: string | null;
  attemptId?: string | null;
  claimId?: string;
  spoolerJobId?: string | null;
  agentId?: string | null;
  printerId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
};

function redactClaimToken(token?: string | null): string | undefined {
  if (!token) return undefined;
  // Never expose raw claim token — security primitive
  // Return opaque redacted identifier: sha256 hash first 12 chars + length
  try {
    const hash = createHash("sha256").update(token).digest("hex").slice(0, 12);
    return `claim_${hash}...(${token.length})`;
  } catch {
    return `claim_${token.slice(0, 4)}...redacted`;
  }
}

function redactClaimIdForTimeline(claimId?: string | null): string | undefined {
  if (!claimId) return undefined;
  // If claimId looks like a UUID (claim_token), redact it
  if (claimId.length > 20 && /^[0-9a-f-]{20,}$/i.test(claimId)) {
    return redactClaimToken(claimId);
  }
  // If already opaque (attempt_ or claim_ prefix with nanoid), allow but still redact if long
  if (claimId.startsWith("claim_") && claimId.length > 20) {
    // It's already opaque nanoid, but still redact to be safe if it contains token
    return claimId.slice(0, 12) + "...";
  }
  return claimId;
}

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

    let timeline: TimelineEntry[];
    if (events.length > 0) {
      timeline = events.map((e: JobEventRow) => ({
        id: e.id,
        stage: e.stage,
        status: e.status,
        at: e.createdAt,
        message: e.message,
        errorCode: e.errorCode,
        attemptId: e.attemptId,
        // Redact claimId — never expose raw claim_token
        claimId: redactClaimIdForTimeline(e.claimId),
        spoolerJobId: e.spoolerJobId,
        agentId: e.agentId,
        printerId: e.printerId,
        requestId: e.requestId,
        metadata: e.metadata,
      }));
    } else {
      timeline = buildTimelineFromJobRow(job).map((t, idx) => ({
        id: `derived_${idx}`,
        stage: t.stage,
        status: t.status,
        at: t.at,
        message: t.message,
        attemptId: job.attemptId,
        // Redact claimToken — never raw
        claimId: redactClaimToken(job.claimToken),
        spoolerJobId: job.spoolerJobId,
        agentId: job.agentId,
        printerId: job.printerId,
        requestId: job.requestId,
        metadata: {},
      }));
    }

    const res = NextResponse.json(
      {
        jobId: id,
        tenantId,
        status: job.status,
        spoolerJobId: job.spoolerJobId,
        attemptId: job.attemptId,
        timeline,
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
