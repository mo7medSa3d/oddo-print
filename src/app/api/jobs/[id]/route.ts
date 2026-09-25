import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { printJobs } from "../../../../db/schema";
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
      payload: printJobs.payload,
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
  if (row.length !== 1) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row[0]);
}
