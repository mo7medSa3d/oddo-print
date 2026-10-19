import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { agents, auditEvents, e2eCaptureRuns } from "../../../db/schema";
import { validateWorkspaceManager } from "../../../lib/manager-auth";
import { requireManagerPermission } from "../../../lib/authorization";
import { requireActiveTenantInTransaction, TenantDeletedError, TenantSuspendedError } from "../../../lib/tenant-guard";
import {
  ManagerMutationAuthorityChangedError,
  requireManagerActorInTransaction,
} from "../../../lib/manager-mutation-authorization";
import { captureEnabled, readBoundedCaptureJSON } from "../../../lib/e2e-capture";
import { logError } from "../../../lib/log";

export const dynamic = "force-dynamic";
const PRIVATE = { "Cache-Control": "private, no-store" };
const ID_RE = /^cap_[0-9a-f]{32}$/;
const AGENT_RE = /^agt_[A-Za-z0-9_-]{8}$/;
const MAX_PAGE = 50;
const MAX_DELETE = 200;

const cleanupSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("finished"), confirm: z.literal(true) }).strict(),
  z.object({ scope: z.literal("one"), runId: z.string().regex(ID_RE), confirm: z.literal(true) }).strict(),
]);

class CaptureConsoleError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

function jsonError(code: string, status: number) {
  return NextResponse.json({ code }, { status, headers: PRIVATE });
}

function consoleError(error: unknown, action: "list" | "clear") {
  if (error instanceof CaptureConsoleError) return jsonError(error.code, error.status);
  if (error instanceof ManagerMutationAuthorityChangedError || error instanceof TenantDeletedError || error instanceof TenantSuspendedError) {
    return jsonError("FORBIDDEN", 403);
  }
  logError("e2e.capture.console_" + action + "_failed", {
    error: error instanceof Error ? error.message : "unknown",
  });
  return jsonError("INTERNAL_ERROR", 500);
}

/**
 * Workspace-only E2E timeline. "queued" proves Odoo reached the Gateway,
 * not that a Windows Agent received the PDF. Never select stored payload,
 * claim tokens, private paths or full-resolution PDF documents.
 *
 * History stays readable when admission is disabled, so operators can still
 * investigate and purge tests created before the feature was switched off.
 */
export async function GET(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return jsonError("UNAUTHORIZED", 401);
  try { requireManagerPermission(claims, "jobs.read"); }
  catch { return jsonError("FORBIDDEN", 403); }

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? MAX_PAGE : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return jsonError("INVALID_LIMIT", 400);
  const filterAgent = url.searchParams.get("agentId");
  if (filterAgent && !AGENT_RE.test(filterAgent)) return jsonError("INVALID_AGENT_ID", 400);
  const beforeRaw = url.searchParams.get("beforeCreatedAt");
  const beforeId = url.searchParams.get("beforeId");
  if ((beforeRaw === null) !== (beforeId === null)) return jsonError("INVALID_CURSOR", 400);
  const before = beforeRaw !== null ? new Date(beforeRaw) : null;
  if (before && (Number.isNaN(before.getTime()) || !ID_RE.test(beforeId ?? ""))) {
    return jsonError("INVALID_CURSOR", 400);
  }

  const tenantFilter = eq(e2eCaptureRuns.tenantId, claims.tenantId);
  const agentFilter = filterAgent ? eq(e2eCaptureRuns.agentId, filterAgent) : undefined;
  const beforeFilter = before && beforeId
    ? or(lt(e2eCaptureRuns.createdAt, before),
      and(eq(e2eCaptureRuns.createdAt, before), lt(e2eCaptureRuns.id, beforeId)))
    : undefined;

  try {
    const [runs, countResult, availableAgents] = await Promise.all([
      db.select({
        runId: e2eCaptureRuns.id,
        agentId: e2eCaptureRuns.agentId,
        agentName: agents.name,
        status: e2eCaptureRuns.status,
        createdAt: e2eCaptureRuns.createdAt,
        updatedAt: e2eCaptureRuns.updatedAt,
        claimedAt: e2eCaptureRuns.claimedAt,
        finishedAt: e2eCaptureRuns.finishedAt,
        expiresAt: e2eCaptureRuns.expiresAt,
        paperMm: e2eCaptureRuns.paperMm,
        pages: e2eCaptureRuns.pages,
        pdfBytes: e2eCaptureRuns.pdfBytes,
        errorCode: e2eCaptureRuns.errorCode,
        previewAvailable: sql<boolean>`(${e2eCaptureRuns.previewJpeg} IS NOT NULL)`,
      }).from(e2eCaptureRuns).leftJoin(agents, and(
        eq(agents.id, e2eCaptureRuns.agentId),
        eq(agents.tenantId, e2eCaptureRuns.tenantId),
      )).where(and(tenantFilter, agentFilter, beforeFilter))
        .orderBy(desc(e2eCaptureRuns.createdAt), desc(e2eCaptureRuns.id))
        .limit(limit + 1),
      db.execute(sql`
        SELECT
          count(*)::integer AS total,
          count(*) FILTER (WHERE claimed_at IS NOT NULL)::integer AS received_by_agent,
          count(*) FILTER (WHERE status = 'rendered_locally')::integer AS completed,
          count(*) FILTER (WHERE status = 'queued' AND expires_at > now())::integer AS waiting,
          count(*) FILTER (WHERE status = 'failed')::integer AS failed,
          EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms
        FROM e2e_capture_runs
        WHERE tenant_id = ${claims.tenantId}
          ${filterAgent ? sql`AND agent_id = ${filterAgent}` : sql``}
      `),
      db.select({ id: agents.id, name: agents.name })
        .from(agents).where(eq(agents.tenantId, claims.tenantId))
        .orderBy(agents.name, agents.id).limit(500),
    ]);
    const hasMore = runs.length > limit;
    const page = runs.slice(0, limit);
    const last = page[page.length - 1];
    const counts = (countResult.rows[0] ?? {}) as Record<string, string | number>;
    const now = Number(counts.now_ms);
    if (!Number.isFinite(now)) throw new Error("Database clock is unavailable");
    return NextResponse.json({
      gatewayCaptureEnabled: captureEnabled(),
      agents: availableAgents,
      simulationOnly: true,
      physicalPrinted: false,
      summary: {
        gatewayReceived: Number(counts.total ?? 0),
        agentReceived: Number(counts.received_by_agent ?? 0),
        rendered: Number(counts.completed ?? 0),
        waiting: Number(counts.waiting ?? 0),
        failed: Number(counts.failed ?? 0),
      },
      items: page.map(({ expiresAt, ...run }) => {
        const expired = (run.status === "queued" || run.status === "claimed")
          && expiresAt.getTime() <= now;
        return {
          ...run,
          status: expired ? "expired" : run.status,
          errorCode: expired ? "CAPTURE_TIMED_OUT" : run.errorCode,
          gatewayReceived: true,
          agentReceived: run.claimedAt !== null,
        };
      }),
      hasMore,
      nextCursor: hasMore && last
        ? { beforeCreatedAt: last.createdAt.toISOString(), beforeId: last.runId }
        : null,
    }, { headers: PRIVATE });
  } catch (error) {
    return consoleError(error, "list");
  }
}

/**
 * An explicit, audited Manager action. Delete at most 200 terminal rows per
 * request. Active queued/claimed tests remain (even when selecting one run);
 * no spooler or physical print_job records are ever touched.
 */
export async function DELETE(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return jsonError("UNAUTHORIZED", 401);
  try { requireManagerPermission(claims, "jobs.cancel"); }
  catch { return jsonError("FORBIDDEN", 403); }

  let payload: unknown;
  try { payload = await readBoundedCaptureJSON(req, 2048); }
  catch { return jsonError("INVALID_REQUEST", 400); }
  const parsed = cleanupSchema.safeParse(payload);
  if (!parsed.success) return jsonError("CONFIRM_REQUIRED", 400);

  try {
    const deleted = await db.transaction(async (tx) => {
      await requireActiveTenantInTransaction(tx, claims.tenantId);
      await requireManagerActorInTransaction(tx, claims, "jobs.cancel");

      const rowFilter = and(eq(e2eCaptureRuns.tenantId, claims.tenantId),
        parsed.data.scope === "one" ? eq(e2eCaptureRuns.id, parsed.data.runId) : undefined);
      if (parsed.data.scope === "one") {
        const [candidate] = await tx.select({
          id: e2eCaptureRuns.id,
          status: e2eCaptureRuns.status,
          active: sql<boolean>`(${e2eCaptureRuns.status} IN ('queued','claimed') AND ${e2eCaptureRuns.expiresAt} > clock_timestamp())`,
        }).from(e2eCaptureRuns).where(rowFilter).limit(1).for("update");
        if (!candidate) throw new CaptureConsoleError("NOT_FOUND", 404);
        if (candidate.active) {
          throw new CaptureConsoleError("CAPTURE_ACTIVE", 409);
        }
      }

      const eligible = sql`(${e2eCaptureRuns.status} IN ('rendered_locally','failed','expired')
        OR (${e2eCaptureRuns.status} IN ('queued','claimed') AND ${e2eCaptureRuns.expiresAt} <= now()))`;
      const candidates = await tx.select({ id: e2eCaptureRuns.id })
        .from(e2eCaptureRuns).where(and(rowFilter, eligible))
        .orderBy(e2eCaptureRuns.createdAt).limit(MAX_DELETE).for("update");
      if (candidates.length === 0) return 0;
      const deletedRows = await tx.delete(e2eCaptureRuns).where(and(
        rowFilter,
        inArray(e2eCaptureRuns.id, candidates.map(x => x.id)),
        eligible,
      )).returning({ id: e2eCaptureRuns.id });
      if (deletedRows.length > 0) {
        await tx.insert(auditEvents).values({
          id: "audit_" + randomBytes(16).toString("hex"),
          tenantId: claims.tenantId,
          actorType: "user",
          actorId: claims.userId ?? claims.jti,
          action: "capture_tests.cleanup",
          resourceType: "e2e_capture_runs",
          resourceId: parsed.data.scope === "one" ? parsed.data.runId : null,
          metadata: { deleted: deletedRows.length, scope: parsed.data.scope },
        });
      }
      return deletedRows.length;
    });
    return NextResponse.json({
      deleted,
      activePreserved: true,
      physicalJobsAffected: false,
      hasMoreEligible: parsed.data.scope === "finished" && deleted === MAX_DELETE,
    }, { headers: PRIVATE });
  } catch (error) { return consoleError(error, "clear"); }
}
