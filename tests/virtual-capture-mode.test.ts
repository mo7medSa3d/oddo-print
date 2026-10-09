import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isVirtualCaptureTestRecord, isVirtualPrinterRecord } from "../src/lib/printer-virtual";
import { GET as probeGateway } from "../src/app/api/agent/probe/route";
import { isPrinterAvailableForJob } from "../src/lib/routing";

const capture = {
  name: "Yaseir Virtual Test Printer",
  printerType: "virtual",
  connectionType: "spooler",
  protocol: "spooler",
  capabilities: { virtual_test_sink: true, registration_source: "config", supported_protocols: ["pdf"] },
};

describe("virtual file-capture testing is isolated from production", () => {
  it("classifies the explicit file sink as virtual, never a production printer", () => {
    expect(isVirtualPrinterRecord(capture)).toBe(true);
    expect(isVirtualCaptureTestRecord(capture)).toBe(true);
    expect(isPrinterAvailableForJob({ ...capture, status: "online", lifecycle: "active", inventoryPresent: true })).toBe(false);
  });

  it("does not allow arbitrary Windows virtual printers, fax queues or redirected sessions", () => {
    for (const record of [
      { name: "Microsoft Print to PDF", printerType: "virtual", connectionType: "spooler", protocol: "spooler" },
      { ...capture, capabilities: { virtual_test_sink: true, registration_source: "discovery" } },
      { ...capture, printerType: "redirected" },
      { ...capture, connectionType: "network" },
      { ...capture, protocol: "raw" },
      { ...capture, capabilities: { virtual_test_sink: "true", registration_source: "config" } },
    ]) {
      expect(isVirtualCaptureTestRecord(record)).toBe(false);
    }
  });

  it("restricts the sink to an explicit paired-Agent or Manager diagnostic, never Odoo", () => {
    const service = readFileSync("src/lib/print-job-service.ts", "utf8");
    const managerRoute = readFileSync("src/app/api/printers/[id]/test-print/route.ts", "utf8");
    const odooRoute = readFileSync("src/app/api/print/jobs/route.ts", "utf8");
    expect(service).toContain('process.env.YASEIR_GATEWAY_VIRTUAL_TEST_MODE === "1"');
    expect(service).toContain('requestedBy === "manager-test"');
    expect(service).toContain('requestedBy === "agent-diagnostic"');
    expect(service).toContain("agentDiagnosticAuthority?.agentId === agentId");
    expect(service).toContain('documentType === "test_page"');
    expect(service).toContain("isVirtualCaptureTestRecord(printerIdentity)");
    expect(service).toContain("&& !reprintOfJobId");
    expect(managerRoute).toContain('requireManagerPermission(claims, "printers.test")');
    expect(managerRoute).toContain("allowVirtualTestCapture: true");
    expect(odooRoute).not.toContain("allowVirtualTestCapture");
  });

  it("advertises paired-Agent virtual registration in the public origin probe", async () => {
    const res = probeGateway();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toMatchObject({
      ok: true, service: "yaseir-print-gateway",
      features: { agentVirtualSpoolerTest: true, pairedAgentDiagnosticCapture: true },
    });
  });
});
