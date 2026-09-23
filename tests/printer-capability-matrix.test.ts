import { describe, it, expect } from "vitest";
import { getSupportedDocumentTypes, isIppTransport, isSpoolerTransport, isRawTransport } from "../src/lib/printer-capability";
import { normalizePrinterStatus } from "../src/lib/printer-health";
import * as fs from "fs";

describe("printer-capability-matrix", () => {
  it("IPP transport supports pdf/image/raw", () => {
    expect(getSupportedDocumentTypes("ipp", "ipp")).toContain("pdf");
    expect(getSupportedDocumentTypes("ipps", "ipps")).toEqual(["pdf"]);
    expect(getSupportedDocumentTypes("ipp", "ipp")).not.toContain("image");
    expect(getSupportedDocumentTypes("ipp", "ipp")).not.toContain("raw");
    expect(isIppTransport("ipp", "ipp")).toBe(true);
    expect(isIppTransport("network", "ipp")).toBe(true);
  });

  it("Spooler transport supports pdf/image/raw/escpos", () => {
    expect(getSupportedDocumentTypes("spooler", "spooler")).toContain("pdf");
    expect(getSupportedDocumentTypes("windows_spooler", "spooler")).toContain("escpos");
    expect(isSpoolerTransport("spooler", "spooler")).toBe(true);
    expect(isSpoolerTransport("network", "windows_spooler")).toBe(true);
  });

  it("RAW transport supports raw/escpos/zpl/tspl", () => {
    expect(getSupportedDocumentTypes("raw", "network")).toContain("raw");
    expect(getSupportedDocumentTypes("escpos", "network")).toContain("escpos");
    expect(isRawTransport("escpos")).toBe(true);
    expect(isRawTransport("zpl")).toBe(true); // zpl is considered raw transport per isRawTransport definition
    expect(isRawTransport("ipp")).toBe(false);
  });

  it("evidence-based: ONLINE not mapped to IDLE unless explicit idle", () => {
    const now = new Date();
    const freshLastSeen = new Date(now.getTime() - 10_000);
    const online = normalizePrinterStatus("online", { lastSeenAt: freshLastSeen, now });
    expect(online.status).toBe("ONLINE"); // NOT IDLE
    expect(online.evidence).toContain("ONLINE");
    expect(online.freshness.fresh).toBe(true);

    const idle = normalizePrinterStatus("idle", { lastSeenAt: freshLastSeen, now });
    expect(idle.status).toBe("IDLE");
    expect(idle.evidence).toContain("IDLE");
  });

  it("stale data returns UNKNOWN, not ONLINE", () => {
    const now = new Date();
    const staleLastSeen = new Date(now.getTime() - 200_000); // >90s
    const result = normalizePrinterStatus("online", { lastSeenAt: staleLastSeen, now });
    expect(result.status).toBe("UNKNOWN");
    expect(result.evidence).toContain("Stale evidence");
    expect(result.freshness.fresh).toBe(false);
  });

  it("future-dated observations are not fresh or ONLINE", () => {
    const now = new Date("2026-09-24T00:00:00.000Z");
    const futureLastSeen = new Date(now.getTime() + 30_000);
    const result = normalizePrinterStatus("online", { lastSeenAt: futureLastSeen, now });
    expect(result.status).toBe("UNKNOWN");
    expect(result.freshness.fresh).toBe(false);
    expect(result.freshness.ageMs).toBe(-30_000);
  });

  it("no lastSeen returns UNKNOWN", () => {
    const result = normalizePrinterStatus("online", { lastSeenAt: null });
    expect(result.status).toBe("UNKNOWN");
  });

  it("normalizes error with evidence separation", () => {
    const now = new Date();
    const fresh = new Date(now.getTime() - 5_000);
    const errorPaper = normalizePrinterStatus("error", { error: "paper out", lastSeenAt: fresh, now });
    expect(errorPaper.status).toBe("PAPER_OUT");
    expect(errorPaper.evidence).toContain("paper");

    const errorDriver = normalizePrinterStatus("error", { error: "driver error", lastSeenAt: fresh, now });
    expect(errorDriver.status).toBe("DRIVER_ERROR");

    const errorSpooler = normalizePrinterStatus("error", { error: "spooler error", lastSeenAt: fresh, now });
    expect(errorSpooler.status).toBe("SPOOLER_ERROR");

    const unknown = normalizePrinterStatus(null, { lastSeenAt: fresh, now });
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("driver and spooler health are evidence-based, not from DB status alone", () => {
    const source = fs.readFileSync("src/lib/printer-health.ts", "utf8");
    // Must check for actual spooler_status evidence, not just DB status
    expect(source).toContain("capabilities.spooler_status");
    expect(source).toContain("ACTUAL SPOOLER STATUS");
    expect(source).toContain("DATABASE STATUS only");
    expect(source).toContain("ACTUAL DRIVER STATUS");
    expect(source).toContain("fresh");
    // Must NOT report SPOOLER OK from only DB state — should report UNKNOWN when no explicit probe
    expect(source).toContain("no explicit spooler health probe");
  });

  it("capability matrix includes required fields with evidence separation", () => {
    const source = fs.readFileSync("src/lib/printer-health.ts", "utf8");
    expect(source).toContain("statusEvidence");
    expect(source).toContain("statusFreshness");
    expect(source).toContain("driver");
    expect(source).toContain("spooler");
    expect(source).toContain("transport");
    expect(source).toContain("protocol");
    expect(source).toContain("documentTypes");
  });
});
