import { verifiedPrinterState } from "./helpers/printer-verification";
import { describe, expect, it } from "vitest";
import { isPrinterAvailableForJob, validatePayloadForPrinter } from "../src/lib/routing";

function printer(overrides: Record<string, unknown> = {}) {
  return {
    ...verifiedPrinterState("printer-1"),
    id: "printer-1", agentId: "agent-1", name: "Physical Printer", printerType: "physical", deviceClass: "thermal",
    connectionType: "network", protocol: "raw", lifecycle: "active", status: "online", capabilities: null, config: {},
    ...overrides,
  };
}

describe("runtime printer routing regressions", () => {
  it("keeps active physical printers routable", () => {
    expect(isPrinterAvailableForJob(printer())).toBe(true);
  });

  it("routes printable virtual printers while rejecting unusable stubs", () => {
    expect(isPrinterAvailableForJob(printer({ printerType: "virtual", connectionType: "spooler", protocol: "spooler" }))).toBe(true);
    expect(isPrinterAvailableForJob(printer({ printerType: "redirected", connectionType: "spooler", protocol: "spooler" }))).toBe(false);
    expect(isPrinterAvailableForJob(printer({ port: "NUL:", connectionType: "spooler", protocol: "spooler" }))).toBe(false);
    expect(isPrinterAvailableForJob(printer({ name: "Canon G4070 series FAX", connectionType: "spooler", protocol: "spooler" }))).toBe(false);
  });

  it("separates unknown health from execution eligibility for connected unidirectional network printers", () => {
    expect(isPrinterAvailableForJob(printer({ status: "unknown", protocol: "escpos" }))).toBe(true);
    // Network + IPP is a valid document transport (printer-model allows it);
    // unknown telemetry with a declared transport is eligible to attempt.
    expect(isPrinterAvailableForJob(printer({ status: "unknown", protocol: "ipp" }))).toBe(true);
    // A Windows spooler queue with unknown telemetry is eligible to attempt:
    // the queue (OpenPrinter/GetPrinter) is the probe, not the Bidi channel.
    expect(isPrinterAvailableForJob(printer({ status: "unknown", connectionType: "spooler" }))).toBe(true);
    expect(isPrinterAvailableForJob(printer({ status: "offline" }))).toBe(false);
    expect(isPrinterAvailableForJob(printer({ lifecycle: "disabled" }))).toBe(false);
    expect(isPrinterAvailableForJob(printer({ inventoryPresent: false }))).toBe(false);
  });

  it("does not silently accept a payload capability the printer does not advertise", () => {
    const result = validatePayloadForPrinter({ type: "image" }, {
      protocol: "raw",
      connectionType: "network",
      capabilities: { supported_protocols: ["raw"] },
    });
    expect(result.ok).toBe(false);
    // Metadata cannot turn a RAW TCP backend into an image renderer.
    expect(validatePayloadForPrinter({ type: "image" }, {
      protocol: "raw",
      connectionType: "network",
      capabilities: { supported_protocols: ["raw", "escpos"] },
    }).ok).toBe(false);
    expect(validatePayloadForPrinter({ type: "image" }, {
      protocol: "escpos",
      connectionType: "network",
      capabilities: { supported_protocols: ["escpos"] },
    }).ok).toBe(false);
  });
});
