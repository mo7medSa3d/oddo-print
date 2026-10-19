import { describe, it, expect } from "vitest";
import { isPrinterClaimable, isPrinterStatusExecutable } from "../src/lib/routing";

/**
 * Eligibility matrix: health/telemetry (online/unknown/offline/error) is
 * separate from execution eligibility (declared transport + no positive
 * evidence against). Claim == executable: one canonical predicate.
 */
describe("printer eligibility matrix", () => {
  it("A. spooler + online -> executable", () => {
    expect(isPrinterStatusExecutable({ status: "online", connectionType: "spooler", protocol: "spooler" })).toBe(true);
    expect(isPrinterClaimable({ status: "online", connectionType: "spooler", protocol: "spooler" })).toBe(true);
  });
  it("B. spooler + unknown + valid queue -> eligible to attempt", () => {
    expect(isPrinterStatusExecutable({ status: "unknown", connectionType: "spooler", protocol: "spooler" })).toBe(true);
    expect(isPrinterClaimable({ status: "unknown", connectionType: "spooler", protocol: "spooler" })).toBe(true);
  });
  it("C. spooler + confirmed offline -> blocked", () => {
    expect(isPrinterStatusExecutable({ status: "offline", connectionType: "spooler", protocol: "spooler" })).toBe(false);
    expect(isPrinterClaimable({ status: "offline", connectionType: "spooler", protocol: "spooler" })).toBe(false);
  });
  it("D. spooler + paper out -> blocked", () => {
    // Paper-out surfaces as "error" in the gateway vocabulary.
    expect(isPrinterStatusExecutable({ status: "error", connectionType: "spooler", protocol: "spooler" })).toBe(false);
  });
  it("E. spooler + paper jam -> blocked", () => {
    expect(isPrinterClaimable({ status: "error", connectionType: "spooler", protocol: "spooler" })).toBe(false);
  });
  it("G. network RAW + unknown + declared protocol -> eligible", () => {
    expect(isPrinterStatusExecutable({ status: "unknown", connectionType: "network", protocol: "raw" })).toBe(true);
    expect(isPrinterClaimable({ status: "unknown", connectionType: "network", protocol: "raw" })).toBe(true);
  });
  it("H. network ESC/POS + unknown + declared protocol -> eligible", () => {
    expect(isPrinterStatusExecutable({ status: "unknown", connectionType: "network", protocol: "escpos" })).toBe(true);
  });
  it("network + unknown + undeclared protocol -> dark, not executable", () => {
    expect(isPrinterStatusExecutable({ status: "unknown", connectionType: "network", protocol: "unknown" })).toBe(false);
  });
  it("network offline/error -> blocked", () => {
    expect(isPrinterStatusExecutable({ status: "offline", connectionType: "network", protocol: "raw" })).toBe(false);
    expect(isPrinterStatusExecutable({ status: "error", connectionType: "network", protocol: "escpos" })).toBe(false);
  });
  it("IPP unknown -> eligible; offline/error -> blocked", () => {
    expect(isPrinterStatusExecutable({ status: "unknown", connectionType: "ipp", protocol: "ipp" })).toBe(true);
    expect(isPrinterStatusExecutable({ status: "offline", connectionType: "ipp", protocol: "ipp" })).toBe(false);
    expect(isPrinterStatusExecutable({ status: "error", connectionType: "ipps", protocol: "ipps" })).toBe(false);
  });
  it("busy -> executable (queues accept more work)", () => {
    expect(isPrinterStatusExecutable({ status: "busy", connectionType: "spooler", protocol: "spooler" })).toBe(true);
    expect(isPrinterStatusExecutable({ status: "busy", connectionType: "network", protocol: "raw" })).toBe(true);
  });
  it("S. WS claim and poll claim share one model (claim == executable)", () => {
    const cases = [
      { status: "online", connectionType: "spooler", protocol: "spooler" },
      { status: "busy", connectionType: "spooler", protocol: "spooler" },
      { status: "unknown", connectionType: "spooler", protocol: "spooler" },
      { status: "offline", connectionType: "spooler", protocol: "spooler" },
      { status: "error", connectionType: "spooler", protocol: "spooler" },
      { status: "online", connectionType: "network", protocol: "raw" },
      { status: "unknown", connectionType: "network", protocol: "raw" },
      { status: "unknown", connectionType: "network", protocol: "unknown" },
      { status: "offline", connectionType: "network", protocol: "raw" },
      { status: "unknown", connectionType: "ipp", protocol: "ipp" },
      { status: "offline", connectionType: "ipp", protocol: "ipp" },
    ];
    for (const tc of cases) {
      expect(isPrinterClaimable(tc), JSON.stringify(tc)).toBe(isPrinterStatusExecutable(tc));
    }
  });
  it("unknown is not online: offline/error still fail closed", () => {
    // Guard against the "make everything claimable" regression.
    expect(isPrinterStatusExecutable({ status: "offline", connectionType: "spooler", protocol: "spooler" })).toBe(false);
    expect(isPrinterStatusExecutable({ status: "error", connectionType: "network", protocol: "zpl" })).toBe(false);
  });
});
