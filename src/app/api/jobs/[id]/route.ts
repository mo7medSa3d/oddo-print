import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { printJobs, printJobReceipts } from "../../../../db/schema";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { and, eq } from "drizzle-orm";
import { buildJobDiagnosticPayload } from "../../../../lib/job-diagnostic-payload";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "jobs.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id } = await params;
  const includePayload = new URL(req.url).searchParams.get("includePayload") === "1";
  if (includePayload) {
    try { requireManagerPermission(claims, "jobs.payload.read"); }
    catch { return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } }); }
  }
  const row = await db
    .select({
      id: printJobs.id,
      destination: printJobs.destination,
      documentType: printJobs.documentType,
      agentId: printJobs.agentId,
      printerId: printJobs.printerId,
      status: printJobs.status,
      error: printJobs.error,
      retries: printJobs.retries,
      deliveryAttempts: printJobs.deliveryAttempts,
      claimedAt: printJobs.claimedAt,
      deliveredAt: printJobs.deliveredAt,
      ackedAt: printJobs.ackedAt,
      expiresAt: printJobs.expiresAt,
      createdAt: printJobs.createdAt,
      updatedAt: printJobs.updatedAt,
      payload: printJobs.payload,
    })
    .from(printJobs)
    .where(and(eq(printJobs.id, id), eq(printJobs.tenantId, claims.tenantId)))
    .limit(1);
  if (row.length !== 1) {
    const receipt = await db.query.printJobReceipts.findFirst({ where: and(eq(printJobReceipts.id, id), eq(printJobReceipts.tenantId, claims.tenantId)) });
    if (!receipt) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { fingerprint: _fingerprint, closedClaimTokenHash: _claimHash, apiKeyId: _apiKey, ...metadata } = receipt;
    return NextResponse.json(
      { ...metadata, archived: true, diagnosticPayload: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const { payload, ...metadata } = row[0];

  // Normal callers receive a redacted transport summary. The interactive job
  // inspector opts in explicitly to the original payload so an authorized
  // workspace manager can inspect/copy exactly what was admitted for this job.
  // The tenant predicate above prevents cross-workspace access, and no-store
  // keeps customer document content out of intermediary caches.
  const diagnosticPayload = includePayload
    ? payload ?? null
    : buildJobDiagnosticPayload(payload);

  return NextResponse.json(
    { ...metadata, diagnosticPayload },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
