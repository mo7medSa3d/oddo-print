import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { printJobs } from "../../../../../db/schema";
import { validateConsoleAuth } from "../../../../../lib/console-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { isTerminal, type JobStatus } from "../../../../../lib/job-status";
import { createPrintJobForPrinter } from "../../../../../lib/print-job-service";
import {
  TenantEntitlementError,
  TenantPrintQuotaExceededError,
  TenantSubscriptionRequiredError,
  TenantEntitlementConfigError,
} from "../../../../../lib/entitlements";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateConsoleAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.kind !== "manager") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try { requireManagerPermission(auth.claims, "jobs.retry"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const { id } = await params;
  const jobId = typeof id === "string" ? id.trim() : "";
  if (!jobId) return NextResponse.json({ error: "job id is required", code: "INVALID_REQUEST" }, { status: 400 });

  const job = await db.query.printJobs.findFirst({
    where: and(eq(printJobs.id, jobId), eq(printJobs.tenantId, auth.claims.tenantId)),
  });
  if (!job) return NextResponse.json({ error: "Job not found", code: "JOB_NOT_FOUND" }, { status: 404 });
  if (!isTerminal(job.status as JobStatus)) {
    return NextResponse.json({
      error: "Only finished, failed, or expired jobs can be reprinted. The current job is still in progress.",
      code: "JOB_NOT_TERMINAL",
    }, { status: 409 });
  }

  try {
    const result = await createPrintJobForPrinter(job.printerId, job.payload, {
      requestedBy: "manager-reprint",
      reprintOfJobId: job.id,
      destination: job.destination,
      documentType: job.documentType ?? undefined,
      tenantId: auth.claims.tenantId,
    });
    return NextResponse.json({ ok: true, jobId: result.id, reused: result.isReused === true }, { status: 201 });
  } catch (error) {
    if (error instanceof TenantPrintQuotaExceededError) {
      const headers = new Headers({ "Cache-Control": "no-store" });
      if (error.periodEnd) headers.set("Retry-After", String(Math.max(1, Math.ceil((error.periodEnd.getTime() - Date.now()) / 1000))));
      return NextResponse.json({
        error: error.message,
        code: error.code,
        entitlement: error.entitlement,
        limit: error.limit,
        used: error.used,
        remaining: 0,
        periodStart: error.periodStart.toISOString(),
        periodEnd: error.periodEnd?.toISOString() ?? null,
        upgradeRequired: true,
        retryable: false,
      }, { status: 429, headers });
    }
    if (error instanceof TenantEntitlementError) {
      return NextResponse.json({
        error: error.message,
        code: "TENANT_ENTITLEMENT_EXCEEDED",
        entitlement: error.entitlement,
        limit: error.limit,
        used: error.used,
        upgradeRequired: true,
        retryable: true,
      }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
    }
    if (error instanceof TenantSubscriptionRequiredError || error instanceof TenantEntitlementConfigError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
