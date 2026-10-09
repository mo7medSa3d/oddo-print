import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { agents, printers, printJobReceipts } from "../../../../../db/schema";
import { derivePhysicalOutcome } from "../../../../../lib/job-status";
import { validateWorkspaceManager } from "../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { requestIdFrom } from "../../../../../lib/log";
import { and, eq } from "drizzle-orm";
import { createPrintJobForPrinter, AgentQueueFullError, AgentQueuedJobsFullError, PrintJobCapabilityError, PrintJobInputError } from "../../../../../lib/print-job-service";
import { TenantEntitlementError, TenantPrintQuotaExceededError, TenantSubscriptionRequiredError, TenantEntitlementConfigError } from "../../../../../lib/entitlements";
import { buildTestPrintPayloadForPrinter } from "../../../../../lib/payload";
import { MAX_AGENT_IN_FLIGHT_JOBS } from "../../../../../lib/job-delivery";
import { logError } from "../../../../../lib/log";
import { databaseNowMs } from "../../../../../lib/database-clock";
import { getAgentAvailability } from "../../../../../lib/agent-availability";

export const dynamic = "force-dynamic";

// Real test print — creates a real printJobs row: queued → claimed → printing → success/failed
// Tauri → Gateway → Agent → Printer (never Tauri → Printer directly).
//
// Manager-authenticated only: a queued test print reaches physical hardware
// and consumes tenant quota, so it must cross the same RBAC boundary as other
// manager-originated physical actions. Agent credentials are execution
// credentials, not user intent credentials. The Odoo addon routes its own
// test pages through the durable outbox (/api/print/jobs with a
// document-scoped key), never this endpoint.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.test"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const tenantId = claims.tenantId;
  const printer = await db.query.printers.findFirst({
    where: and(eq(printers.id, id), eq(printers.tenantId, tenantId)),
  });
  if (!printer) return NextResponse.json({ error: "Printer not found" }, { status: 404 });

  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() || null;
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 200)) {
    return NextResponse.json({ error: "invalid Idempotency-Key", code: "INVALID_REQUEST", retryable: false }, { status: 400 });
  }
  // Do not return a reused print identity from an unchecked preflight read.
  // The canonical queue transaction validates Manager authority before reuse.


  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, printer.agentId), eq(agents.tenantId, tenantId)) });
  if (!agent) return NextResponse.json({ error: "Printer owner agent missing", code: "AGENT_NOT_FOUND" }, { status: 404 });
  if (printer.lifecycle !== "active") return NextResponse.json({ error: "printer disabled" }, { status: 409 });
  // Diagnostic Test Print is intentionally fail-fast when the owning Agent
  // cannot accept work. No job has been persisted at this point, so say that
  // explicitly instead of implying a queued job exists.
  const availability = getAgentAvailability(agent);
  if (!availability.available) {
    return NextResponse.json({
      error: `Agent is unavailable (${availability.reason}). Test print was not queued; reconnect or restore the Agent and try again.`,
      code: "AGENT_OFFLINE",
      retryable: true,
    }, { status: 503 });
  }

  let payload: ReturnType<typeof buildTestPrintPayloadForPrinter>;
  try {
    payload = buildTestPrintPayloadForPrinter(printer.name, agent.name ?? printer.agentId, {
      protocol: printer.protocol,
      connectionType: printer.connectionType,
      capabilities: printer.capabilities,
    }, idempotencyKey ?? undefined);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Test page not supported for this printer", code: "CAPABILITY_MISMATCH", retryable: false }, { status: 422 });
  }



  try {
    const result = await createPrintJobForPrinter(printer.id, payload, {
      requestedBy: "manager-test",
      managerAuthority: { claims, permission: "printers.test" },
      documentType: "test_page",
      allowVirtualTestCapture: true,
      idempotencyKey,
      tenantId: tenantId,
      requestId: requestIdFrom(req),
    });
    // Idempotent replay can surface a terminal receipt after the live job was
    // cleaned. Preserve the terminal physical-outcome marker for honest UI
    // presentation; never infer paper output from transport success alone.
    // This read is for display only; the owning transaction already fenced
    // Manager authority and verified the idempotency fingerprint.
    let physicalOutcome: "printed" | "not_printed" | "unknown" | undefined;
    if (result.isReused && (result.status === "success" || result.status === "failed" || result.status === "expired")) {
      try {
        const receipt = await db.query.printJobReceipts.findFirst({
          where: and(eq(printJobReceipts.id, result.id), eq(printJobReceipts.tenantId, tenantId)),
        });
        if (receipt?.status === result.status && receipt.printerId === printer.id) {
          physicalOutcome = derivePhysicalOutcome(result.status, receipt.error);
        }
      } catch {
        // The job is already accepted: degrading its display metadata must not
        // force a second physical intent. The client treats absent as UNKNOWN.
      }
    }
    return NextResponse.json({
      ok: true, jobId: result.id, printerId: printer.id, status: result.status,
      isReused: result.isReused,
      ...(physicalOutcome ? { physicalOutcome } : {}),
      virtualCapture: printer.printerType === "virtual" && (printer.capabilities as Record<string, unknown> | null)?.virtual_test_sink === true,
      note: printer.printerType === "virtual" ? "Virtual test captures a file on the Agent; no physical paper is printed." : undefined,
    }, { status: 201 });
  } catch (e) {
    if (e instanceof TenantPrintQuotaExceededError) {
      const headers = new Headers({ "Cache-Control": "no-store" });
      if (e.periodEnd) {
        try {
          const dbNowMs = await databaseNowMs();
          headers.set("Retry-After", String(Math.max(1, Math.ceil((e.periodEnd.getTime() - dbNowMs) / 1000))));
        } catch {
          // The quota decision already succeeded inside PostgreSQL. Do not
          // fall back to the Node host wall clock when calculating Retry-After.
          headers.set("Retry-After", "60");
        }
      }
      return NextResponse.json({
        error: e.message,
        code: e.code,
        entitlement: e.entitlement,
        limit: e.limit,
        used: e.used,
        remaining: 0,
        periodStart: e.periodStart.toISOString(),
        periodEnd: e.periodEnd?.toISOString() ?? null,
        upgradeRequired: true,
        retryable: false,
      }, { status: 429, headers });
    }
    if (e instanceof TenantEntitlementError) {
      return NextResponse.json({
        error: e.message,
        code: e.code,
        entitlement: e.entitlement,
        limit: e.limit,
        used: e.used,
        upgradeRequired: true,
        retryable: true,
      }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
    }
    if (e instanceof TenantSubscriptionRequiredError || e instanceof TenantEntitlementConfigError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 403 });
    }
    if (e instanceof AgentQueueFullError || e instanceof AgentQueuedJobsFullError) {
      return NextResponse.json({
        error: "AGENT_QUEUE_FULL",
        code: "AGENT_QUEUE_FULL",
        agentId: e.agentId,
        limit: MAX_AGENT_IN_FLIGHT_JOBS,
        retryable: true,
      }, { status: 503 });
    }
    if (e instanceof PrintJobCapabilityError) {
      return NextResponse.json({ error: e.message, code: e.code, retryable: false }, { status: 422 });
    }
    if (e instanceof PrintJobInputError) {
      return NextResponse.json({ error: e.message, code: e.code, retryable: e.status >= 500 }, { status: e.status });
    }
    logError("printer.test_print_failed", { printerId: id, error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
