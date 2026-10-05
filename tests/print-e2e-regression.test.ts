import { describe, expect, it } from "vitest";
import fs from "fs";
import { validatePayloadForPrinter, getSupportedDocumentTypes } from "../src/lib/printer-capability";
import { buildTestPrintPayloadForPrinter } from "../src/lib/payload";
import { parsePrinterInput, validateConnectionConfig } from "../src/lib/printer-model";
import { getEffectivePrinterStatus } from "../src/lib/agent-availability";

describe("print end-to-end regressions", () => {
  const spooler = { protocol: "spooler", connectionType: "spooler" };

  it("A/B: Windows spooler document test works with missing supported_protocols", () => {
    expect(validatePayloadForPrinter({ type: "pdf" }, spooler).ok).toBe(true);
    const payload = buildTestPrintPayloadForPrinter("Receipt", "Agent", spooler, "op-1");
    expect(payload.type).toBe("pdf");
    expect(payload.encoding).toBe("base64");
  });

  it("C: missing spooler ESC/POS capability is rejected with an explainable reason", () => {
    const result = validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, spooler);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("has not been declared as ESC/POS-capable");
  });

  it("D/E: explicitly declared spooler ESC/POS and RAW passthrough succeed without losing documents", () => {
    const escpos = { ...spooler, capabilities: { supported_protocols: ["escpos"] } };
    const raw = { ...spooler, capabilities: { supported_protocols: ["raw"] } };
    expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, escpos).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "raw", protocol: "raw" }, raw).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "pdf" }, escpos).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "image" }, raw).ok).toBe(true);
  });

  it("H: capability mismatch is independent from online/offline health", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    const printer = { lifecycle: "active", status: "online", lastSeenAt: new Date(now.getTime() - 5_000) };
    expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, spooler).ok).toBe(false);
    expect(getEffectivePrinterStatus(printer, null, now)).toBe("online");
  });

  it("I: a spooler queue does not require IP or TCP port", () => {
    expect(validateConnectionConfig("spooler", { spooler_name: "Thermal Receipt" }, "spooler")).toBeNull();
    expect(parsePrinterInput({
      agentId: "agent-1", name: "Receipt", connectionType: "spooler", protocol: "spooler",
      config: { spooler_name: "Thermal Receipt", passthrough_protocols: ["escpos"] },
    }).config.passthrough_protocols).toEqual(["escpos"]);
  });

  it("J: Windows document jobs use the driver-rendered path, not RAW WritePrinter", () => {
    const source = fs.readFileSync("agent/internal/printer/spooler_windows.go", "utf8");
    const block = source.slice(source.indexOf("func (p *SpoolerPrinter) PrintDocument"), source.indexOf("// SpoolerProbe"));
    expect(block).toContain("case KindPDF:");
    expect(block).toContain("return p.printPDFDocument(ctx, doc)");
    expect(block).toContain("case KindRaw, KindESCPOS:");
    expect(block).toContain("return p.Print(ctx, doc.Data)");
    expect(source).toContain('UTF16PtrFromString("RAW")');
  });

  it("F/G/K: Odoo exact binding test uses binding document type and validates identity before capability", () => {
    const router = fs.readFileSync("odoo_addons/print_gateway/models/print_router.py", "utf8");
    const binding = fs.readFileSync("odoo_addons/print_gateway/models/binding.py", "utf8");
    const testBlock = router.slice(router.indexOf("def route_test_page"), router.indexOf("def _generate_test_pdf"));
    expect(testBlock).toContain("document_type=binding.document_type");
    expect(testBlock).not.toContain('job_document_type="test_page"');
    const rawRoute = router.slice(router.indexOf("def route_raw_command"), router.indexOf("def route_test_page"));
    expect(rawRoute).toContain("explicit_destination=destination");
    expect(rawRoute).not.toContain("explicit_destination=binding.destination_ref or destination");
    const action = binding.slice(binding.indexOf("def action_send_test_print"), binding.indexOf("def action_verify_remote_hardware"));
    expect(action).not.toContain("self.write({\"printer_protocol\"");
    const runtime = binding.slice(binding.indexOf("def _validate_runtime_target"), binding.indexOf("def action_send_test_print"));
    expect(runtime.indexOf("The selected Gateway Runtime Printer is not found.")).toBeGreaterThan(-1);
    expect(runtime.indexOf("The selected Gateway Runtime Printer is not found.")).toBeLessThan(runtime.indexOf("Gateway Runtime Printer does not belong"));
  });

  it("spooler capability list stays document-first and passthrough is additive", () => {
    expect(getSupportedDocumentTypes("spooler", "spooler", { supported_protocols: ["escpos", "raw"] }))
      .toEqual(["pdf", "image", "raw", "escpos"]);
  });
});
