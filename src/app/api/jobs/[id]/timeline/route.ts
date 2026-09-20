import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { printJobs } from "../../../../../db/schema";
import { validateConsoleAuth } from "../../../../../lib/console-auth";
import { and, eq } from "drizzle-orm";
import { getJobTimeline, buildTimelineFromJobRow } from "../../../../../lib/job-timeline";
import { getCorrelationContext, runWithCorrelation, generateRequestId } from "../../../../../server/correlation";
import { requestIdFrom } from "../../../../../lib/log";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = auth.kind === "manager" ? auth.claims.tenantId : auth.agent.tenantId;

  // Correlation
  const incomingReqId = (req as any).headers?.get?.("x-request-id") ?? new Request(req.url, { headers: req.headers }).headers.get("x-request-id");
  const requestId = requestIdFrom(req as any) || generateRequestId();
  const correlation = { requestId, tenantId, jobId: id };

  return runWithCorrelation(correlation as any, async () => {
    // Fetch job row
    const rows = await db.select().from(printJobs).where(and(eq(printJobs.tenantId, tenantId), eq(printJobs.id, id))).limit(1);
    if (rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "x-request-id": requestId } });
    }
    const job = rows[0] as any;

    // Try to get real events table; fallback to derived timeline if table empty/missing
    let events: any[] = [];
    try {
      events = await getJobTimeline(tenantId, id);
    } catch {
      events = [];
    }

    let timeline: any[];
    if (events.length > 0) {
      timeline = events.map((e: any) => ({
        id: e.id,
        stage: e.stage,
        status: e.status,
        at: e.createdAt,
        message: e.message,
        errorCode: e.errorCode,
        attemptId: e.attemptId,
        claimId: e.claimId,
        spoolerJobId: e.spoolerJobId,
        agentId: e.agentId,
        printerId: e.printerId,
        requestId: e.requestId,
        metadata: e.metadata,
      }));
    } else {
      // Derived from job row (legacy)
      timeline = buildTimelineFromJobRow(job).map((t, idx) => ({
        id: `derived_${idx}`,
        stage: t.stage,
        status: t.status,
        at: t.at,
        message: t.message,
        attemptId: job.attemptId,
        claimId: job.claimToken ? `${job.claimToken.slice(0, 8)}...` : undefined,
        spoolerJobId: job.spoolerJobId,
        agentId: job.agentId,
        printerId: job.printerId,
        requestId: job.requestId,
        metadata: {},
      }));
    }

    // Add correlation headers
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
          claimId: job.claimToken,
          spoolerJobId: job.spoolerJobId,
        },
      },
      { headers: { "x-request-id": requestId } }
    );
    return res;
  });
}
