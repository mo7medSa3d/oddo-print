import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getSupportedDocumentTypes,
  isIppTransport,
  isSpoolerTransport,
  isRawTransport,
  validatePayloadForPrinter,
  hasDeclaredProtocol,
} from "../src/lib/printer-capability";
import { buildTestPrintPayloadForPrinter } from "../src/lib/payload";

const root = process.cwd();

describe("printer-capability-matrix", () => {
  it("IPP transport supports only PDF", () => {
    expect(getSupportedDocumentTypes("ipp", "ipp")).toEqual(["pdf"]);
    expect(getSupportedDocumentTypes("ipps", "ipps")).toEqual(["pdf"]);
    expect(isIppTransport("ipp", "ipp")).toBe(true);
    expect(isIppTransport("network", "ipp")).toBe(true);
  });

  it("Spooler transport retains PDF while images require verified geometry", () => {
    expect(getSupportedDocumentTypes("spooler", "spooler")).toContain("pdf");
    expect(getSupportedDocumentTypes("spooler", "spooler")).not.toContain("image");
    expect(getSupportedDocumentTypes("spooler", "spooler")).not.toContain("raw");
    expect(getSupportedDocumentTypes("windows_spooler", "spooler")).not.toContain("escpos");
    expect(isSpoolerTransport("spooler", "spooler")).toBe(true);
    expect(isSpoolerTransport("spooler", "windows_spooler")).toBe(true);
    expect(isSpoolerTransport("network", "windows_spooler")).toBe(false);
  });

  it("keeps legacy windows_spooler protocol scoped to a spooler transport", () => {
    expect(getSupportedDocumentTypes("windows_spooler", "spooler")).toEqual(["pdf"]);
    expect(getSupportedDocumentTypes("windows_spooler", "network")).toEqual([]);
    expect(getSupportedDocumentTypes("ipps", "network")).toEqual(["pdf"]);
  });

  it("RAW transport supports raw only", () => {
    expect(getSupportedDocumentTypes("raw", "network")).toEqual(["raw"]);
    expect(getSupportedDocumentTypes("escpos", "network")).toContain("escpos");
    expect(isRawTransport("escpos")).toBe(true);
    expect(isRawTransport("zpl")).toBe(true);
    expect(isRawTransport("ipp")).toBe(false);
  });

  it("removes legacy cloud printer-health module under Direct Odoo <-> Agent architecture", () => {
    expect(existsSync(join(root, "src/lib/printer-health.ts"))).toBe(false);
    expect(existsSync(join(root, "src/app/api/printers/route.ts"))).toBe(false);
  });

  it("keeps document-transport baseline while explicit byte capabilities stay additive", () => {
    expect(getSupportedDocumentTypes("spooler", "spooler", { supported_protocols: [] })).toEqual(["pdf"]);
    expect(getSupportedDocumentTypes("spooler", "spooler", { supported_protocols: ["escpos"] })).toEqual(["pdf", "raw", "escpos"]);
    expect(getSupportedDocumentTypes("spooler", "spooler", { supported_protocols: ["raw"] })).toEqual(["pdf", "raw"]);
    expect(getSupportedDocumentTypes("escpos", "usb", { supported_protocols: ["image", "escpos"] })).not.toContain("image");
    expect(getSupportedDocumentTypes("raw", "network", { supported_protocols: ["pdf"] })).toEqual([]);
    expect(getSupportedDocumentTypes("ipp", "ipp", { supported_protocols: ["image"] })).toEqual(["pdf"]);
  });
});

describe("physical IPP transport must not be inferred from a bare protocol label", () => {
  it("rejects USB or unknown IPP labels while keeping network IPP", () => {
    expect(isIppTransport("usb", "ipp")).toBe(false);
    expect(isIppTransport("network", "ipps")).toBe(true);
    expect(isSpoolerTransport("usb", "spooler")).toBe(true);
  });
});

it("uses the same declared capability tokens for binding, matrix and admission", () => {
  const capabilities = { supported_protocols: [" ESCPOS "] };
  expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, { connectionType: "network", protocol: "escpos", capabilities }).ok).toBe(true);
  expect(getSupportedDocumentTypes("escpos", "network", capabilities)).toEqual(["escpos", "raw"]);
  expect(getSupportedDocumentTypes("spooler", "spooler", capabilities)).toEqual(["pdf", "raw", "escpos"]);
  expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, { connectionType: "network", protocol: "raw", capabilities }).ok).toBe(false);
});

it("does not create a byte transport from a language label alone", () => {
  for (const connectionType of ["", "unknown", "ipp", "ipps", "lpr", "serial", "bluetooth"]) {
    for (const protocol of ["raw", "escpos", "zpl", "tspl"]) {
      expect(validatePayloadForPrinter({ type: "raw", protocol }, { connectionType, protocol }).ok).toBe(false);
    }
  }
});

it("never coerces malformed capability values into printer language permissions", () => {
  const capabilities = { supported_protocols: [["escpos"], { protocol: "escpos" }] } as unknown as { supported_protocols: string[] };
  expect(hasDeclaredProtocol(capabilities, "escpos")).toBe(false);
  expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, { connectionType: "network", protocol: "escpos", capabilities }).ok).toBe(false);
  expect(getSupportedDocumentTypes("escpos", "network", capabilities)).toEqual([]);
  expect(() => buildTestPrintPayloadForPrinter("Receipt", "Agent", { connectionType: "network", protocol: "escpos", capabilities })).toThrow(/no supported test ticket/);
  expect(getSupportedDocumentTypes("spooler", "spooler", capabilities)).toEqual(["pdf"]);
});
