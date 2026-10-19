import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../../../db";
import { e2eCaptureRuns } from "../../../../../db/schema";
import { validateAgent } from "../../../../../lib/agent-auth";
import { captureEnabled } from "../../../../../lib/e2e-capture";
import { logError } from "../../../../../lib/log";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Read-only, Agent-scoped test inbox for the Windows desktop.
 * This must never claim work or return raw documents, claim tokens, API keys,
 * private Windows paths, or documents belonging to another paired Agent.
 */
export async function GET(req: Request) {
  if (!captureEnabled()) {
    return NextResponse.json({ code: "CAPTURE_NOT_ENABLED" }, { status: 404, headers: NO_STORE });
  }
  const agent = await validateAgent(req.headers.get("authorization"));
  if (!agent) {
    return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: NO_STORE });
  }
  try {
    const rows = await db.select({
      runId: e2eCaptureRuns.id,
      status: e2eCaptureRuns.status,
      createdAt: e2eCaptureRuns.createdAt,
      claimedAt: e2eCaptureRuns.claimedAt,
      finishedAt: e2eCaptureRuns.finishedAt,
      expired: sql<boolean>`(${e2eCaptureRuns.status} IN ('queued', 'claimed') AND ${e2eCaptureRuns.expiresAt} <= now())`,
      paperMm: e2eCaptureRuns.paperMm,
      pages: e2eCaptureRuns.pages,
      pdfBytes: e2eCaptureRuns.pdfBytes,
      errorCode: e2eCaptureRuns.errorCode,
    }).from(e2eCaptureRuns).where(and(
      eq(e2eCaptureRuns.tenantId, agent.tenantId),
      eq(e2eCaptureRuns.agentId, agent.id),
    )).orderBy(desc(e2eCaptureRuns.createdAt), desc(e2eCaptureRuns.id)).limit(10);

    // A read does not mutate/claim an Agent job. Show an accurate expiry
    // even when Odoo has not refreshed the run to persist its terminal state.
    return NextResponse.json({
      simulationOnly: true,
      physicalPrinted: false,
      items: rows.map(({ expired, ...row }) => {
        return {
          ...row,
          status: expired ? "expired" : row.status,
          errorCode: expired ? "CAPTURE_TIMED_OUT" : row.errorCode,
        };
      }),
    }, { headers: NO_STORE });
  } catch (error) {
    logError("e2e.capture.status_error", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: NO_STORE });
  }
}


/**
 * Explicit privacy purge for the authenticated, paired Agent only.
 *
 * Completed/failed/expired simulations and truly timed-out queued claims are
 * eligible. Live queued/claimed work is NEVER deleted: doing so would lose
 * the Agent's in-progress capture result. Printing jobs are a separate table.
 * This remains available even when capture admission is switched off, so a
 * disabled test feature does not trap private test documents indefinitely.
 */
export async function DELETE(req: Request) {
  const agent = await validateAgent(req.headers.get("authorization"));
  if (!agent) {
    return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: NO_STORE });
  }
  try {
    const removed = await db.execute(sql`
      WITH removed AS (
        DELETE FROM e2e_capture_runs
        WHERE tenant_id = ${agent.tenantId} AND agent_id = ${agent.id}
          AND (
            status IN ('rendered_locally', 'failed', 'expired')
            OR (status IN ('queued', 'claimed') AND expires_at <= now())
          )
        RETURNING id
      )
      SELECT COUNT(*)::integer AS deleted FROM removed
    `);
    return NextResponse.json({
      deleted: Number((removed.rows[0] as { deleted?: number } | undefined)?.deleted ?? 0),
      activePreserved: true,
      physicalJobsAffected: false,
    }, { headers: NO_STORE });
  } catch (error) {
    logError("e2e.capture.cleanup_error", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: NO_STORE });
  }
}
