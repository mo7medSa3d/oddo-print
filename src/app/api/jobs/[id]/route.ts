import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { printJobs, printJobReceipts } from "../../../../db/schema";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "jobs.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id } = await params;
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
    })
    .from(printJobs)
    .where(and(eq(printJobs.id, id), eq(printJobs.tenantId, claims.tenantId)))
    .limit(1);
  if (row.length !== 1) {
    const receipt = await db.query.printJobReceipts.findFirst({ where: and(eq(printJobReceipts.id, id), eq(printJobReceipts.tenantId, claims.tenantId)) });
    if (!receipt) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { fingerprint: _fingerprint, closedClaimTokenHash: _claimHash, apiKeyId: _apiKey, ...metadata } = receipt;
    return NextResponse.json({ ...metadata, archived: true });
  }
  // Payload is intentionally excluded: it may contain sensitive print data
  // (invoices, labels with PII). The diagnostic payload is available via the
  // timeline endpoint which redacts appropriately.
  return NextResponse.json(row[0]);
}
