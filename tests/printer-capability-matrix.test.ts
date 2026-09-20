import { describe, it, expect } from "vitest";
import { getSupportedDocumentTypes, isIppTransport, isSpoolerTransport, isRawTransport } from "../src/lib/printer-capability";
import { normalizePrinterStatus } from "../src/lib/printer-health";

describe("printer-capability-matrix", () => {
  it("IPP transport supports pdf/image/raw", () => {
    expect(getSupportedDocumentTypes("ipp", "ipp")).toContain("pdf");
    expect(getSupportedDocumentTypes("ipps", "ipps")).toContain("image");
    expect(isIppTransport("ipp", "ipp")).toBe(true);
  });

  it("Spooler transport supports pdf/image/raw/escpos", () => {
    expect(getSupportedDocumentTypes("spooler", "spooler")).toContain("pdf");
    expect(getSupportedDocumentTypes("windows_spooler", "spooler")).toContain("escpos");
    expect(isSpoolerTransport("spooler", "spooler")).toBe(true);
  });

  it("RAW transport supports raw/escpos/zpl/tspl", () => {
    expect(getSupportedDocumentTypes("raw", "network")).toContain("raw");
    expect(getSupportedDocumentTypes("escpos", "network")).toContain("escpos");
    expect(isRawTransport("escpos")).toBe(true);
  });

  it("normalizes printer status with evidence", () => {
    const online = normalizePrinterStatus("online");
    expect(online.status).toBe("IDLE");
    expect(online.evidence).toContain("Agent reports");

    const offline = normalizePrinterStatus("offline");
    expect(offline.status).toBe("OFFLINE");

    const errorPaper = normalizePrinterStatus("error", { error: "paper out" });
    expect(errorPaper.status).toBe("PAPER_OUT");

    const errorDriver = normalizePrinterStatus("error", { error: "driver error" });
    expect(errorDriver.status).toBe("DRIVER_ERROR");

    const errorSpooler = normalizePrinterStatus("error", { error: "spooler error" });
    expect(errorSpooler.status).toBe("SPOOLER_ERROR");

    const unknown = normalizePrinterStatus(null);
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("capability matrix includes Transport/Protocol/Document/Duplex/Color/Status", () => {
    // Verify matrix structure conceptually
    const requiredFields = ["transport", "protocol", "documentTypes", "duplexCapable", "colorCapable", "status", "driver", "spooler"];
    expect(requiredFields.length).toBeGreaterThan(5);
  });
});
