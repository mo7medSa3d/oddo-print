import { requireActiveTenantInTransaction } from "../../../lib/tenant-guard";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../lib/manager-mutation-authorization";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { idempotencyDigest } from "../../../lib/print-job-service";
import { printJobs, printJobReceipts } from "../../../db/schema";
import { validateWorkspaceManager } from "../../../lib/manager-auth";
import { validateConsoleAuth } from "../../../lib/console-auth";
import { requireManagerPermission } from "../../../lib/authorization";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { clampListLimit } from "../../../lib/request-limits";
import { RECEIPT_MATERIALIZE_BATCH_ROWS } from "../../../shared/job-retention";
import {
  isJobFilterStatus,
  derivePhysicalOutcome,
  PHYSICAL_OUTCOME_UNKNOWN_MARKERS,
} from "../../../lib/job-status";
import { databaseNowMs } from "../../../lib/database-clock";

export const dynamic = "force-dynamic";

const TERMINAL_JOB_STATUSES = ["success", "failed", "expired"] as const;
const MAX_CLEANUP_ROWS = 5000;
const MAX_LIST_OFFSET = 10_000;
const MAX_SEARCH_LENGTH = 64;

export async function GET(req: Request) {
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = auth.kind === "manager" ? auth.claims.tenantId : auth.agent.tenantId;
  if (auth.kind === "manager") {
    try { requireManagerPermission(auth.claims, "jobs.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  }

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status")?.trim().toLowerCase();
  const searchParam = (url.searchParams.get("search") ?? url.searchParams.get("q"))?.trim();
  const printerId = url.searchParams.get("printerId");
  const agentId = url.searchParams.get("agentId");
  const limit = clampListLimit(url.searchParams.get("limit"), 50, 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);
  if (offset > MAX_LIST_OFFSET) {
    return NextResponse.json({ error: `offset must be <= ${MAX_LIST_OFFSET}` }, { status: 400 });
  }
  if (searchParam && (searchParam.length < 2 || searchParam.length > MAX_SEARCH_LENGTH)) {
    return NextResponse.json({ error: `search must be between 2 and ${MAX_SEARCH_LENGTH} characters` }, { status: 400 });
  }

  if (statusParam && !isJobFilterStatus(statusParam)) {
    return NextResponse.json({ error: "invalid status filter" }, { status: 400 });
  }

  const conditions = [eq(printJobs.tenantId, tenantId)];
  if (auth.kind === "agent") conditions.push(eq(printJobs.agentId, auth.agent.id));

  if (statusParam && statusParam !== "all") {
    if (statusParam === "active" || statusParam === "in_flight") {
      conditions.push(inArray(printJobs.status, ["queued", "claimed", "printing"]));
    } else if (statusParam === "queued" || statusParam === "claimed" || statusParam === "printing" || statusParam === "expired") {
      conditions.push(eq(printJobs.status, statusParam));
    } else if (statusParam === "success" || statusParam === "printed") {
      conditions.push(eq(printJobs.status, "success"));
    } else if (statusParam === "unknown" || statusParam === "attention") {
      conditions.push(
        // Non-null: PHYSICAL_OUTCOME_UNKNOWN_MARKERS is a non-empty tuple, so or() always receives >= 1 clause.
        or(...PHYSICAL_OUTCOME_UNKNOWN_MARKERS.map((m) => sql`${printJobs.error} LIKE ${m + "%"}`))!
      );
    } else if (statusParam === "failed") {
      conditions.push(
        // Non-null: and() always receives the fixed eq() clause plus the marker clauses.
        and(
          eq(printJobs.status, "failed"),
          ...PHYSICAL_OUTCOME_UNKNOWN_MARKERS.map((m) => sql`COALESCE(${printJobs.error}, '') NOT LIKE ${m + "%"}`)
        )!
      );
    } else if (statusParam === "unassigned") {
      conditions.push(
        // The NOT IN subqueries were previously untenant-fenced full scans
        // (`id FROM printers`/`id FROM agents`) rebuilt on every poll even
        // though the outer row is tenant-scoped. Composite tenant+id indexes
        // exist (printers_tenant_id_unique / agents_tenant_id_unique), so
        // fencing the subqueries by tenant_id lets PostgreSQL answer them
        // with index-only scans.
        or(eq(printJobs.destination, "unassigned"), eq(printJobs.printerId, "unassigned"), sql`${printJobs.printerId} NOT IN (SELECT id FROM printers WHERE tenant_id = ${printJobs.tenantId} AND lifecycle = 'active')`, sql`${printJobs.agentId} NOT IN (SELECT id FROM agents WHERE tenant_id = ${printJobs.tenantId} AND lifecycle = 'active')`)!
      );
    }
  }

  if (printerId) conditions.push(eq(printJobs.printerId, printerId));
  if (agentId) conditions.push(eq(printJobs.agentId, agentId));

  if (searchParam) {
    // Escape LIKE wildcards: `%`/`_` in user input must match literally and
    // `\` is the ESCAPE character (same policy as getDashboardJobs in
    // src/app/actions.ts and the reprint LIKE in print-job-service.ts).
    // Without this, a job-search term containing `_` matches far more rows
    // than the operator typed.
    const escaped = searchParam.toLowerCase().replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const term = `%${escaped}%`;
    conditions.push(
      // Non-null: or() always receives six fixed LIKE clauses.
      // ESCAPE is literal SQL text (NOT an interpolated binding —
      // Drizzle would send that as a parameter and Postgres would
      // reject `LIKE $1 $2`).
      or(
        sql`LOWER(${printJobs.id}) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(COALESCE(${printJobs.destination}, '')) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(COALESCE(${printJobs.documentType}, '')) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(${printJobs.printerId}) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(${printJobs.agentId}) LIKE ${term} ESCAPE '\\'`,
        sql`LOWER(COALESCE(${printJobs.error}, '')) LIKE ${term} ESCAPE '\\'`
      )!
    );
  }

  const rows = await db
    .select({
      id: printJobs.id,
      destination: printJobs.destination,
      documentType: printJobs.documentType,
      agentId: printJobs.agentId,
      printerId: printJobs.printerId,
      status: printJobs.status,
      error: printJobs.error,
      requestedBy: printJobs.requestedBy,
      idempotencyKey: printJobs.idempotencyKey,
      retries: printJobs.retries,
      deliveryAttempts: printJobs.deliveryAttempts,
      claimedAt: printJobs.claimedAt,
      deliveredAt: printJobs.deliveredAt,
      ackedAt: printJobs.ackedAt,
      expiresAt: printJobs.expiresAt,
      createdAt: printJobs.createdAt,
      updatedAt: printJobs.updatedAt,
    })
    .from(printJobs)
    .where(conditions.length ? and(...conditions)! : undefined)
    .orderBy(desc(printJobs.createdAt))
    .limit(limit)
    .offset(offset);
  // physicalOutcome is part of the job truth contract (shared with
  // derivePhysicalOutcome on the agent protocol): "failed" alone must never be
  // shown as "definitely not printed" when an unknown-outcome marker proves
  // the printer may have received the job.
  return NextResponse.json(rows.map((row) => ({ ...row, physicalOutcome: derivePhysicalOutcome(row.status, row.error) })));
}

export async function DELETE(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "jobs.cancel"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const url = new URL(req.url);
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");
  const confirm = url.searchParams.get("confirm");
  if (confirm !== "1") return NextResponse.json({ error: "Cleanup requires confirm=1" }, { status: 400 });
  if (!beforeRaw) return NextResponse.json({ error: "Cleanup requires before=<ISO-8601 timestamp>" }, { status: 400 });

  const before = new Date(beforeRaw);
  if (Number.isNaN(before.getTime())) return NextResponse.json({ error: "before must be a valid ISO-8601 timestamp" }, { status: 400 });
  const databaseNow = await databaseNowMs();
  if (before.getTime() > databaseNow) return NextResponse.json({ error: "before cannot be in the future" }, { status: 400 });

  const requestedLimit = limitRaw === null ? MAX_CLEANUP_ROWS : Number(limitRaw);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_CLEANUP_ROWS) {
    return NextResponse.json({ error: `limit must be an integer between 1 and ${MAX_CLEANUP_ROWS}` }, { status: 400 });
  }

  let deleted: number;
  try { deleted = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:tenant:${claims.tenantId}`}))`);
    // IDs first: materializing up to 5000 full rows (payloads up to 5 MiB)
    // would exhaust Gateway memory. Full rows are fetched in small inner
    // batches below, so peak memory stays bounded by RECEIPT_MATERIALIZE_BATCH_ROWS.
    const candidateIds = await tx.select({ id: printJobs.id }).from(printJobs).where(
      and(
        eq(printJobs.tenantId, claims.tenantId),
        inArray(printJobs.status, [...TERMINAL_JOB_STATUSES]),
        // Match the automatic retention boundary: only a terminal row whose
        // execution fence has been fully released can be removed. Ambiguous
        // outcomes keep claim_token until their bounded reconciliation window
        // closes, then the payload-free receipt preserves their final evidence.
        isNull(printJobs.claimToken),
        lt(printJobs.updatedAt, before),
      ),
    ).orderBy(printJobs.updatedAt).limit(requestedLimit).for("update");
    await requireActiveTenantInTransaction(tx, claims.tenantId);
    await requireManagerActorInTransaction(tx, claims, "jobs.cancel");
    if (candidateIds.length === 0) return 0;
    let count = 0;
    for (let offset = 0; offset < candidateIds.length; offset += RECEIPT_MATERIALIZE_BATCH_ROWS) {
      const batchIds = candidateIds.slice(offset, offset + RECEIPT_MATERIALIZE_BATCH_ROWS).map((row) => row.id);
      const candidates = await tx.select().from(printJobs).where(inArray(printJobs.id, batchIds)).for("update");
      // One multi-row INSERT per inner batch (same shape as the automatic
      // retention sweep in cleanupTerminalPrintJobs): a per-row INSERT here
      // costs one round-trip per terminal job, up to MAX_CLEANUP_ROWS statements.
      // No conflict guard is needed — this transaction holds the tenant
      // advisory lock, so no concurrent cleanup can materialize the same
      // receipt id (receipt id = job id, job still locked here).
      if (candidates.length > 0) {
        await tx.insert(printJobReceipts).values(candidates.map((row) => ({
          id: row.id, tenantId: row.tenantId, idempotencyKey: row.idempotencyKey,
          fingerprint: idempotencyDigest({ printerId: row.printerId, documentType: row.documentType, destination: row.destination, payload: row.payload }),
          printerId: row.printerId, agentId: row.agentId, apiKeyId: row.apiKeyId,
          destination: row.destination, documentType: row.documentType, requestedBy: row.requestedBy,
          status: row.status, error: row.error, closedClaimTokenHash: row.closedClaimTokenHash,
          deliveredAt: row.deliveredAt, ackedAt: row.ackedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
        })));
      }
      const result = await tx.delete(printJobs).where(and(eq(printJobs.tenantId, claims.tenantId), inArray(printJobs.id, batchIds)));
      count += result.rowCount ?? 0;
    }
    return count;
  });
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
  return NextResponse.json({ deleted, before: before.toISOString(), limit: requestedLimit });
}