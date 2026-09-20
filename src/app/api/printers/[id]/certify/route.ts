import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { printers, printJobs } from "../../../../../db/schema";
import { validateManager } from "../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { and, eq } from "drizzle-orm";
import { nanoid } from "../../../../../lib/nanoid";
import { recordJobEvent } from "../../../../../lib/job-timeline";
import { getCorrelationContext, runWithCorrelation, generateRequestId, generateAttemptId } from "../../../../../server/correlation";
import { requestIdFrom } from "../../../../../lib/log";
import { getPrinterCapabilityMatrix } from "../../../../../lib/printer-health";

export const dynamic = "force-dynamic";

/**
 * Real Print Certification Mode
 * Wizard steps: Gateway → Auth → Queue → Claim → Agent → Transport → Physical → Ack → Final
 * POST /api/printers/[id]/certify
 * Body: { documentType?: string, testPage?: boolean }
 * Creates a real job, records timeline events, and returns certification steps with BLOCKED handling for physical verification.
 */

const CERTIFICATION_STEPS = [
  { id: "gateway", label: "Gateway", description: "Gateway reachable and authenticated" },
  { id: "auth", label: "Auth", description: "Tenant and printer ownership verified" },
  { id: "queue", label: "Queue", description: "Job enqueued with idempotency" },
  { id: "claim", label: "Claim", description: "Agent claim fencing (advisory lock + claim_token)" },
  { id: "agent", label: "Agent", description: "Agent online and heartbeat fresh" },
  { id: "transport", label: "Transport", description: "Transport selected (RAW/IPP/Spooler)" },
  { id: "physical", label: "Physical", description: "Physical paper verification (BLOCKED if no printer)" },
  { id: "ack", label: "Ack", description: "Agent ack success" },
  { id: "final", label: "Final", description: "Certification complete" },
];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: printerId } = await params;
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.test"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const requestId = requestIdFrom(req as any) || generateRequestId();
  const attemptId = generateAttemptId();
  const tenantId = claims.tenantId;

  return runWithCorrelation({ requestId, tenantId, printerId, attemptId } as any, async () => {
    // Step 1: Gateway
    const steps: any[] = CERTIFICATION_STEPS.map(s => ({ ...s, status: "pending" as const, at: null as string | null, message: "", evidence: "" }));
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

    // Step 2: Auth + printer ownership
    const printerRows = await db.select().from(printers).where(and(eq(printers.tenantId, tenantId), eq(printers.id, printerId))).limit(1);
    if (printerRows.length === 0) {
      setStep("auth", "error", "Printer not found or not owned by tenant", `printerId=${printerId} tenantId=${tenantId}`);
      return NextResponse.json({ printerId, requestId, steps, certified: false, blocked: false }, { headers: { "x-request-id": requestId } });
    }
    const printer = printerRows[0] as any;
    setStep("auth", "ok", `Printer ${printer.name} owned by tenant`, `printerId=${printerId} agentId=${printer.agentId}`);

    // Capability matrix
    const capability = await getPrinterCapabilityMatrix(tenantId, printerId).catch(() => null);

    // Step 3: Queue — create real job
    let jobId: string | null = null;
    try {
      const body = await req.json().catch(() => ({}));
      const testPage = body.testPage !== false; // default true
      const documentType = body.documentType || "raw";

      jobId = `cert_${nanoid(12)}`;
      const payload = testPage
        ? {
            type: "raw" as const,
            protocol: (printer.protocol === "unknown" ? "raw" : printer.protocol) as any,
            // YASSER TEST PAGE — no secrets
            data: Buffer.from(
              `YASSER TEST PAGE\nPrinter: ${printer.name}\nTenant: ${tenantId}\nJob: ${jobId}\nRequest: ${requestId}\nTime: ${new Date().toISOString()}\nTransport: ${printer.connectionType}/${printer.protocol}\n\nThis is a diagnostic test page for certification.\nNo secrets are printed.\n`.repeat(2)
            ).toString("base64"),
          }
        : {
            type: "raw" as const,
            protocol: (printer.protocol === "unknown" ? "raw" : printer.protocol) as any,
            data: Buffer.from(`CERTIFICATION ${jobId} ${requestId}`).toString("base64"),
          };

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await db.insert(printJobs).values({
        id: jobId,
        tenantId,
        agentId: printer.agentId,
        printerId: printer.id,
        status: "queued",
        payload: payload as any,
        requestId,
        attemptId,
        documentType,
        expiresAt,
      } as any);

      await recordJobEvent({
        jobId,
        tenantId,
        stage: "created",
        status: "ok",
        message: "Certification job created",
        attemptId,
        printerId,
        agentId: printer.agentId,
        requestId,
        metadata: { certification: true, testPage },
      });
      await recordJobEvent({
        jobId,
        tenantId,
        stage: "queued",
        status: "ok",
        message: `Queued for agent ${printer.agentId}`,
        attemptId,
        printerId,
        agentId: printer.agentId,
        requestId,
      });

      setStep("queue", "ok", `Job ${jobId} queued`, `jobId=${jobId} expiresAt=${expiresAt.toISOString()}`);
    } catch (e) {
      setStep("queue", "error", `Failed to queue: ${String(e).slice(0, 200)}`, String(e).slice(0, 500));
      return NextResponse.json({ printerId, requestId, steps, certified: false, blocked: false, capability }, { headers: { "x-request-id": requestId } });
    }

    // Step 4: Claim — check if agent online would claim
    // We don't actually claim here; we check agent health
    const agentCheck = await db.execute as any;
    let agentOnline = false;
    try {
      const { agents } = await import("../../../../../db/schema");
      const { db: dbClient } = await import("../../../../../db/client");
      const agentRows = await dbClient.select().from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.id, printer.agentId))).limit(1);
      const agent = agentRows[0] as any;
      if (agent?.lastSeenAt) {
        const age = Date.now() - new Date(agent.lastSeenAt).getTime();
        agentOnline = age <= 90_000;
        if (agentOnline) {
          setStep("claim", "ok", `Agent ${printer.agentId} online, will claim via advisory lock`, `lastSeen ${Math.round(age/1000)}s ago`);
        } else {
          setStep("claim", "blocked", `Agent offline (last seen ${Math.round(age/1000)}s ago) — cannot claim`, `agentId=${printer.agentId} lastSeenAt=${agent.lastSeenAt}`);
        }
      } else {
        setStep("claim", "blocked", "Agent never seen — cannot claim", `agentId=${printer.agentId}`);
      }
    } catch {
      setStep("claim", "blocked", "Agent health check failed — treating as BLOCKED", "health check error");
    }

    // Step 5: Agent
    if (agentOnline) {
      setStep("agent", "ok", `Agent ${printer.agentId} online`, `agentId=${printer.agentId}`);
    } else {
      setStep("agent", "blocked", "Agent offline — certification BLOCKED at agent step", `agentId=${printer.agentId}`);
    }

    // Step 6: Transport
    const transport = `${printer.connectionType}/${printer.protocol}`;
    const isSpooler = printer.connectionType === "spooler" || printer.protocol === "spooler" || printer.protocol === "windows_spooler";
    const isIpp = printer.connectionType === "ipp" || printer.connectionType === "ipps" || printer.protocol === "ipp" || printer.protocol === "ipps";
    const isRaw = !isSpooler && !isIpp;
    let transportMsg = `Transport ${transport}`;
    if (isSpooler) transportMsg += " — Windows Spooler (requires spooler job linking)";
    if (isIpp) transportMsg += " — IPP Everywhere (modern, preferred)";
    if (isRaw) transportMsg += " — RAW direct (legacy, ensure driver health)";
    setStep("transport", "ok", transportMsg, `transport=${transport}`);

    // Step 7: Physical — always BLOCKED in sandbox, requires real printer
    setStep("physical", "blocked", "Physical verification requires real printer — BLOCKED in sandbox, must be verified on hardware", "BLOCKED: no physical printer in sandbox; test-print job created but paper outcome unverified");

    // Step 8: Ack — pending until agent acks
    setStep("ack", "pending", "Waiting for agent ack (job will be claimed and acked by agent)", `jobId=${jobId}`);

    // Step 9: Final — not certified until physical
    const blockedSteps = steps.filter(s => s.status === "blocked");
    const hasError = steps.some(s => s.status === "error");
    const certified = false; // Never auto-certify without physical proof
    const blocked = blockedSteps.length > 0;

    setStep("final", blocked ? "blocked" : hasError ? "error" : "pending", blocked ? `Certification BLOCKED at ${blockedSteps.map(s=>s.label).join(", ")} — requires hardware verification` : "Certification pending physical verification", `certified=${certified} blocked=${blocked}`);

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
        metadata: { certification: true, steps },
      }).catch(()=>{});
    }

    return NextResponse.json(
      {
        printerId,
        jobId,
        requestId,
        attemptId,
        steps,
        capability,
        certified,
        blocked,
        blockedReasons: blockedSteps.map(s => ({ step: s.id, label: s.label, message: s.message })),
        instructions: "To complete certification: 1) Ensure agent online, 2) Ensure printer reachable, 3) Check Gateway→Spooler Job linking (spoolerJobId), 4) Verify physical paper output YASSER TEST PAGE, 5) Confirm ack success. In sandbox this remains BLOCKED by design.",
        timelineUrl: `/api/jobs/${jobId}/timeline`,
      },
      { headers: { "x-request-id": requestId } }
    );
  });
}
