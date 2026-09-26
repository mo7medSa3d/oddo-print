import { NextResponse } from "next/server";
import type { InferSelectModel } from "drizzle-orm";
import { db } from "../../../../../db";
import { printJobs, printers, agents } from "../../../../../db/schema";
import { validateWorkspaceManager } from "../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { and, eq } from "drizzle-orm";
import { nanoid } from "../../../../../lib/nanoid";
import { recordJobEvent } from "../../../../../lib/job-timeline";
import { runWithCorrelation, generateRequestId, generateAttemptId } from "../../../../../server/correlation";
import { requestIdFrom, logError, logWarn } from "../../../../../lib/log";
import { getPrinterCapabilityMatrix } from "../../../../../lib/printer-health";
import { createPrintJobForPrinter, AgentQueueFullError, AgentQueuedJobsFullError, PrintJobCapabilityError, PrintJobInputError } from "../../../../../lib/print-job-service";
import { TenantEntitlementError, TenantSubscriptionRequiredError, TenantEntitlementConfigError } from "../../../../../lib/entitlements";
import { MAX_AGENT_IN_FLIGHT_JOBS } from "../../../../../lib/job-delivery";
import { databaseNowMs } from "../../../../../lib/database-clock";

export const dynamic = "force-dynamic";

/**
 * Real Print Certification Mode — CANONICAL PIPELINE
 * Uses createPrintJobForPrinter (same as production) to ensure:
 * tenant validation, printer lifecycle, virtual rejection, executable status,
 * agent ownership, protocol/capability validation, entitlements, queue limits,
 * idempotency, transactional admission, runtime owner revalidation, notification.
 *
 * Wizard steps are state-driven from actual job row, not inferred from lastSeenAt.
 * Physical remains BLOCKED when no hardware.
 */

const CERTIFICATION_STEPS = [
  { id: "gateway", label: "Gateway", description: "Gateway reachable and authenticated" },
  { id: "auth", label: "Auth", description: "Tenant and printer ownership verified" },
  { id: "queue", label: "Queue", description: "Job enqueued with idempotency (canonical pipeline)" },
  { id: "claim", label: "Claim", description: "Agent claim fencing (advisory lock + claim_token) — observed from job status" },
  { id: "agent", label: "Agent", description: "Agent claimed job — observed, not inferred" },
  { id: "transport", label: "Transport", description: "Transport selected (RAW/IPP/Spooler) — observed from job" },
  { id: "physical", label: "Physical", description: "Physical paper verification (BLOCKED if no hardware)" },
  { id: "ack", label: "Ack", description: "Agent ack success — observed from job status" },
  { id: "final", label: "Final", description: "Certification complete" },
] as const;

type CertificationStepStatus = "ok" | "error" | "blocked" | "pending" | "running";
type CertificationStep = (typeof CERTIFICATION_STEPS)[number] & {
  status: CertificationStepStatus;
  at: string | null;
  message: string;
  evidence: string;
};
type PrintJobRow = InferSelectModel<typeof printJobs>;
type AgentRow = InferSelectModel<typeof agents>;
type PrinterRow = InferSelectModel<typeof printers>;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: printerId } = await params;
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.test"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const requestId = requestIdFrom(req) || generateRequestId();
  const attemptId = generateAttemptId();
  const tenantId = claims.tenantId;

  return runWithCorrelation({ requestId, tenantId, printerId, attemptId }, async () => {
    const steps: CertificationStep[] = CERTIFICATION_STEPS.map(s => ({ ...s, status: "pending" as const, at: null, message: "", evidence: "" }));
    function setStep(id: string, status: "ok" | "error" | "blocked" | "pending" | "running", message: string, evidence?: string) {
      const st = steps.find(s => s.id === id);
      if (st) {
        st.status = status;
        st.at = new Date().toISOString();
        st.message = message;
        st.evidence = evidence ?? message;
      }
    }

    setStep("gateway", "ok", "Gateway reachable", `request_id=${requestId}`);
    // Certification constructs an expiry and interprets DB last-seen timestamps,
    // so use the same PostgreSQL clock as canonical job admission and delivery.
    const certificationNowMs = await databaseNowMs();

    // Auth: tenant + printer ownership via DB, same as canonical pre-check
    const printerRows = await db.select().from(printers).where(and(eq(printers.tenantId, tenantId), eq(printers.id, printerId))).limit(1);
    if (printerRows.length === 0) {
      setStep("auth", "error", "Printer not found or not owned by tenant", `printerId=${printerId} tenantId=${tenantId}`);
      return NextResponse.json({ printerId, requestId, steps, certified: false, blocked: false }, { headers: { "x-request-id": requestId } });
    }
    const printer: PrinterRow = printerRows[0];
    setStep("auth", "ok", `Printer ${printer.name} owned by tenant`, `printerId=${printerId} agentId=${printer.agentId}`);

    let capability;
    try {
      capability = await getPrinterCapabilityMatrix(tenantId, printerId);
    } catch (error) {
      logError("print.certification.capability_lookup_failed", { requestId, printerId, tenantId, error: error instanceof Error ? error.message : "unknown" });
      setStep("auth", "error", "Unable to verify printer capabilities", `printerId=${printerId}`);
      return NextResponse.json({ printerId, requestId, steps, certified: false, blocked: false, code: "CAPABILITY_LOOKUP_FAILED" }, { status: 503, headers: { "x-request-id": requestId } });
    }

    // Queue: use canonical pipeline with real idempotency key
    let jobId: string | null = null;
    let jobStatus: string = "unknown";
    let isReused = false;
    try {
      const body = await req.json().catch(() => ({}));
      const testPage = body.testPage !== false;
      const documentType = body.documentType || "raw";
      // Idempotency: header preferred, then body, then deterministic fallback per certification session
      const headerKey = req.headers.get("Idempotency-Key")?.trim();
      const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : null;
      const providedKey = headerKey || bodyKey;
      // If the client provides a key, preserve it across retries. Otherwise the auto-key
      // deduplicates double-clicks for the same tenant/printer within one minute.
      // Explicit Idempotency-Key is the contract for retry-safe response-loss recovery across time;
      // the auto-key is intentionally short-lived convenience deduplication only
      const minuteBucket = Math.floor(certificationNowMs / 60000);
      const autoKey = `cert:${printerId}:${tenantId}:${minuteBucket}`;
      const idempotencyKey = providedKey && providedKey.length >= 8 && providedKey.length <= 200 ? providedKey : autoKey;

      if (providedKey && (providedKey.length < 8 || providedKey.length > 200)) {
        setStep("queue", "error", "Invalid Idempotency-Key length", `length=${providedKey.length}`);
        return NextResponse.json({ error: "invalid Idempotency-Key", code: "INVALID_REQUEST", steps }, { status: 400, headers: { "x-request-id": requestId } });
      }

      // Build payload YASSER TEST PAGE — no secrets, using raw protocol matching printer
      // The printable payload MUST be deterministic for one idempotency key.
      // A retry after a lost HTTP response must produce the same fingerprint so
      // createPrintJobForPrinter can safely reuse the original physical attempt
      // instead of turning a transport ambiguity into an idempotency conflict.
      const payload = testPage
        ? {
            type: "raw" as const,
            protocol: printer.protocol === "unknown" ? ("raw" as const) : printer.protocol,
            data: Buffer.from(
              `YASSER TEST PAGE\nPrinter: ${printer.name}\nTenant: ${tenantId}\nJob: ${idempotencyKey}\nTransport: ${printer.connectionType}/${printer.protocol}\n\nThis is a diagnostic test page for certification.\nNo credentials are printed.\n`.repeat(2)
            ).toString("base64"),
          }
        : {
            type: "raw" as const,
            protocol: printer.protocol === "unknown" ? ("raw" as const) : printer.protocol,
            data: Buffer.from(`CERTIFICATION ${idempotencyKey}`).toString("base64"),
          };

      const expiresAt = new Date(certificationNowMs + 5 * 60 * 1000);

      // Canonical admission path — same as production
      const result = await createPrintJobForPrinter(printerId, payload, {
        requestedBy: `certification:${claims.userId ?? "manager"}`,
        documentType,
        idempotencyKey,
        tenantId,
        requestId,
        expiresAt,
      });

      jobId = result.id;
      jobStatus = result.status;
      isReused = !!result.isReused;

      setStep("queue", "ok", isReused ? `Job ${jobId} reused via idempotency key ${idempotencyKey}` : `Job ${jobId} queued via canonical pipeline`, `jobId=${jobId} idempotencyKey=${idempotencyKey} expiresAt=${expiresAt.toISOString()} isReused=${isReused}`);

      // Record timeline already handled by print-job-service, but also add certification marker
      if (!isReused) {
        await recordJobEvent({
          jobId,
          tenantId,
          stage: "created",
          status: "ok",
          message: "Certification job created via canonical pipeline",
          attemptId,
          printerId,
          agentId: printer.agentId,
          requestId,
          metadata: { certification: true, testPage, idempotencyKey },
        }).catch((e: unknown) => logWarn("print.certification.event_persist_failed", { requestId, printerId, jobId, error: e instanceof Error ? e.message : "unknown" }));
      }

    } catch (e) {
      // Map canonical errors to steps
      if (e instanceof TenantEntitlementError) {
        setStep("queue", "error", `Entitlement: ${e.message}`, `code=${e.code}`);
        return NextResponse.json({ error: e.message, code: e.code, steps, capability }, { status: 429, headers: { "x-request-id": requestId, "Retry-After": "60" } });
      }
      if (e instanceof TenantSubscriptionRequiredError || e instanceof TenantEntitlementConfigError) {
        // Both classes declare a literal `readonly code`, so the union narrowed
        // by these two instanceof checks exposes `code`/`message` directly.
        setStep("queue", "error", e.message, `code=${e.code}`);
        return NextResponse.json({ error: e.message, code: e.code, steps, capability }, { status: 403, headers: { "x-request-id": requestId } });
      }
      if (e instanceof AgentQueueFullError || e instanceof AgentQueuedJobsFullError) {
        setStep("queue", "blocked", `Agent queue full: ${e.message}`, `agentId=${e.agentId} limit=${MAX_AGENT_IN_FLIGHT_JOBS}`);
        return NextResponse.json({ error: "AGENT_QUEUE_FULL", code: "AGENT_QUEUE_FULL", steps, capability }, { status: 503, headers: { "x-request-id": requestId } });
      }
      if (e instanceof PrintJobCapabilityError) {
        setStep("queue", "error", `Capability mismatch: ${e.message}`, `code=${e.code}`);
        return NextResponse.json({ error: e.message, code: e.code, steps, capability }, { status: 422, headers: { "x-request-id": requestId } });
      }
      if (e instanceof PrintJobInputError) {
        setStep("queue", "error", e.message, `code=${e.code}`);
        return NextResponse.json({ error: e.message, code: e.code, steps, capability }, { status: e.status, headers: { "x-request-id": requestId } });
      }
      // Same typed-unknown idiom as api/print/jobs/route.ts: the conflict is a
      // plain Error carrying a `code` property, so narrow before reading it.
      if (e instanceof Error && (e as Error & { code?: string }).code === "IDEMPOTENCY_CONFLICT") {
        setStep("queue", "error", "Idempotency conflict: same key but different payload", `key conflict`);
        return NextResponse.json({ error: "Idempotency conflict", code: "IDEMPOTENCY_CONFLICT", steps, capability }, { status: 409, headers: { "x-request-id": requestId } });
      }
      logError("certification.queue_failed", { printerId, tenantId, requestId, error: e instanceof Error ? e.message : String(e) });
      setStep("queue", "error", `Failed to queue: ${String(e).slice(0, 200)}`, String(e).slice(0, 500));
      return NextResponse.json({ printerId, requestId, steps, certified: false, blocked: false, capability }, { status: 500, headers: { "x-request-id": requestId } });
    }

    // Now derive state-driven steps from actual job row, not inferred
    // Fetch fresh job row
    let freshJob: PrintJobRow | null = null;
    let jobStateLookupFailed = false;
    try {
      const rows = await db.select().from(printJobs).where(and(eq(printJobs.tenantId, tenantId), eq(printJobs.id, jobId!))).limit(1);
      freshJob = rows[0] ?? null;
      if (freshJob) jobStatus = freshJob.status;
    } catch (error) {
      jobStateLookupFailed = true;
      logError("print.certification.job_state_lookup_failed", { requestId, printerId, tenantId, jobId, error: error instanceof Error ? error.message : "unknown" });
      setStep("claim", "error", "Unable to verify queued job state", `jobId=${jobId}`);
      setStep("agent", "error", "Agent state cannot be verified while Gateway database access is unavailable", `agentId=${printer.agentId}`);
    }

    // Claim step: observed from job status
    if (jobStateLookupFailed) {
      // Keep the explicit error state; do not reinterpret a DB outage as a
      // missing job/pending claim.
    } else if (!freshJob) {
      setStep("claim", "pending", "Job row not found after enqueue — pending", `jobId=${jobId}`);
    } else if (freshJob.status === "queued") {
      setStep("claim", "pending", `Job queued, waiting for agent ${printer.agentId} to claim via advisory lock`, `jobId=${jobId} status=queued`);
    } else if (["claimed", "printing", "success", "failed"].includes(freshJob.status)) {
      setStep("claim", "ok", `Job ${freshJob.status} — claimed at ${freshJob.claimedAt?.toISOString() ?? "unknown"}`, `claimToken present=${!!freshJob.claimToken} attemptId=${freshJob.attemptId ?? "n/a"}`);
    } else if (freshJob.status === "expired") {
      setStep("claim", "error", "Job expired before claim", `status=expired`);
    } else {
      setStep("claim", "pending", `Job status ${freshJob.status} — claim pending`, `status=${freshJob.status}`);
    }

    // Agent step: observed from claim
    if (jobStateLookupFailed) {
      // Agent state was already marked as an explicit error above.
    } else if (!freshJob) {
      setStep("agent", "pending", "Waiting for job row", `jobId=${jobId}`);
    } else if (freshJob.status === "queued") {
      // Check agent health but don't claim PASS — pending unless claimed
      let agent: AgentRow | null = null;
      let agentLookupFailed = false;
      try {
        const agentRows = await db.select().from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.id, printer.agentId))).limit(1);
        agent = agentRows[0] ?? null;
      } catch (error) {
        agentLookupFailed = true;
        logError("print.certification.agent_lookup_failed", { requestId, printerId, tenantId, agentId: printer.agentId, error: error instanceof Error ? error.message : "unknown" });
        setStep("agent", "error", "Unable to verify agent health", `agentId=${printer.agentId}`);
      }
      if (agentLookupFailed) {
        // Preserve the explicit database verification error.
      } else if (!agent) {
        setStep("agent", "error", "Agent not found", `agentId=${printer.agentId}`);
      } else if (!agent.lastSeenAt) {
        setStep("agent", "pending", "Agent never seen — waiting for heartbeat", `agentId=${printer.agentId}`);
      } else {
        const age = certificationNowMs - new Date(agent.lastSeenAt).getTime();
        if (age <= 90_000) {
          setStep("agent", "pending", `Agent online ${Math.round(age/1000)}s ago, waiting to claim`, `agentId=${printer.agentId} lastSeen ${Math.round(age/1000)}s`);
        } else {
          setStep("agent", "blocked", `Agent offline last seen ${Math.round(age/1000)}s ago — cannot claim`, `agentId=${printer.agentId} lastSeenAt=${agent.lastSeenAt}`);
        }
      }
    } else if (["claimed", "printing", "success", "failed"].includes(freshJob.status)) {
      setStep("agent", "ok", `Agent ${printer.agentId} claimed job at ${freshJob.claimedAt?.toISOString() ?? "unknown"}`, `agentId=${printer.agentId} status=${freshJob.status}`);
    } else {
      setStep("agent", "pending", `Job status ${freshJob.status} — agent step pending`, `status=${freshJob.status}`);
    }

    // Transport step: observed from printer config and job status
    const transport = `${printer.connectionType}/${printer.protocol}`;
    if (jobStateLookupFailed) {
      setStep("transport", "error", "Unable to verify transport execution state", `jobId=${jobId}`);
    } else if (!freshJob || freshJob.status === "queued") {
      setStep("transport", "pending", `Transport ${transport} selected, waiting for claim to observe execution`, `transport=${transport}`);
    } else {
      const isSpooler = printer.connectionType === "spooler" || printer.protocol === "spooler" || printer.protocol === "windows_spooler";
      const isIpp = printer.connectionType === "ipp" || printer.connectionType === "ipps" || printer.protocol === "ipp" || printer.protocol === "ipps";
      const isRaw = !isSpooler && !isIpp;
      let msg = `Transport ${transport}`;
      if (isSpooler) msg += " — Windows Spooler (requires spooler job linking)";
      if (isIpp) msg += " — IPP (modern, preferred)";
      if (isRaw) msg += " — RAW direct";
      setStep("transport", "ok", msg, `transport=${transport} status=${freshJob.status}`);
    }

    // Physical — always BLOCKED in sandbox, never auto-ok
    setStep("physical", "blocked", "Physical verification requires real printer — BLOCKED in sandbox, must be verified on hardware", "BLOCKED: no physical printer in sandbox; test-print job created but paper outcome unverified");

    // Ack — observed from job status
    if (jobStateLookupFailed) {
      setStep("ack", "error", "Unable to verify agent acknowledgement", `jobId=${jobId}`);
    } else if (!freshJob) {
      setStep("ack", "pending", "Waiting for job row", `jobId=${jobId}`);
    } else if (freshJob.status === "success") {
      setStep("ack", "ok", `Agent acked success at ${freshJob.ackedAt?.toISOString() ?? freshJob.updatedAt?.toISOString() ?? "unknown"}`, `spoolerJobId=${freshJob.spoolerJobId ?? "n/a"} status=success`);
    } else if (freshJob.status === "failed") {
      setStep("ack", "error", `Agent reported failed: ${freshJob.error?.slice(0, 200) ?? "unknown"}`, `status=failed error=${freshJob.error?.slice(0,100)}`);
    } else if (freshJob.status === "expired") {
      setStep("ack", "error", "Job expired before ack", `status=expired`);
    } else {
      setStep("ack", "pending", `Waiting for agent ack — current status ${freshJob.status}`, `jobId=${jobId} status=${freshJob.status}`);
    }

    // Final
    const blockedSteps = steps.filter(s => s.status === "blocked");
    const hasError = steps.some(s => s.status === "error");
    const pendingSteps = steps.filter(s => s.status === "pending" && s.id !== "final");
    const certified = false; // Never auto-certify without physical proof
    const blocked = blockedSteps.length > 0;

    if (pendingSteps.length > 0) {
      setStep("final", "pending", `Certification pending — waiting for ${pendingSteps.map(s => s.label).join(", ")}`, `pending=${pendingSteps.map(s=>s.id).join(",")} certified=${certified}`);
    } else if (blocked) {
      setStep("final", "blocked", `Certification BLOCKED at ${blockedSteps.map(s=>s.label).join(", ")} — requires hardware verification`, `certified=${certified} blocked=${blocked}`);
    } else if (hasError) {
      setStep("final", "error", `Certification failed — ${steps.filter(s=>s.status==="error").map(s=>s.label).join(", ")}`, `certified=${certified}`);
    } else {
      setStep("final", "pending", "Certification pending physical verification — all observed steps ok but physical BLOCKED", `certified=${certified} blocked=${blocked}`);
    }

    if (jobId) {
      await recordJobEvent({
        jobId,
        tenantId,
        stage: "blocked",
        status: "blocked",
        message: "Certification blocked at physical step — sandbox has no printer",
        attemptId,
        printerId,
        agentId: printer.agentId,
        requestId,
        metadata: { certification: true, steps, isReused },
      }).catch(()=>{});
    }

    return NextResponse.json(
      {
        printerId,
        jobId,
        requestId,
        attemptId,
        isReused,
        steps,
        capability,
        certified,
        blocked,
        blockedReasons: blockedSteps.map(s => ({ step: s.id, label: s.label, message: s.message })),
        pendingReasons: pendingSteps.map(s => ({ step: s.id, label: s.label, message: s.message })),
        instructions: "To complete certification: 1) Ensure agent online, 2) Ensure printer reachable, 3) Check Gateway→Spooler Job linking (spoolerJobId), 4) Verify physical paper output YASSER TEST PAGE, 5) Confirm ack success. In sandbox this remains BLOCKED by design. Double-click uses same Idempotency-Key to avoid duplicates.",
        timelineUrl: `/api/jobs/${jobId}/timeline`,
      },
      { headers: { "x-request-id": requestId } }
    );
  });
}
