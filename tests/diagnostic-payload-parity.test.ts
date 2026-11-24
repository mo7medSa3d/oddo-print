import { describe, expect, it } from "vitest";
import { buildTestPdfPayload, buildTestPrintPayloadForPrinter, validatePrintJobPayload } from "../src/lib/payload";
import { validatePayloadForPrinter } from "../src/lib/printer-capability";

describe("diagnostic payload and physical transport admission", () => {
  it("builds an admissible ticket for every implemented direct byte language", () => {
    for (const connectionType of ["network", "usb"] as const) {
      for (const protocol of ["raw", "escpos", "zpl", "tspl"] as const) {
        for (const capabilities of [null, { supported_protocols: [protocol] }]) {
          const printer = { connectionType, protocol, capabilities };
          const payload = buildTestPrintPayloadForPrinter("Selected device", "Owner", printer, "same-operation");
          expect(validatePrintJobPayload(payload)).toEqual(payload);
          expect(payload.type).toBe(protocol === "escpos" ? "escpos" : "raw");
          expect(payload.protocol).toBe(protocol);
          expect(validatePayloadForPrinter(payload, printer).ok).toBe(true);
          expect(buildTestPrintPayloadForPrinter("Selected device", "Owner", printer, "same-operation")).toEqual(payload);
        }
      }
    }
  });

  it("keeps intrinsic document rendering when a language label is not executable passthrough", () => {
    for (const connectionType of ["spooler", "ipp", "ipps"] as const) {
      for (const protocol of ["raw", "escpos", "zpl", "tspl", "unknown"] as const) {
        const printer = { connectionType, protocol, capabilities: null };
        const payload = buildTestPrintPayloadForPrinter("Installed document queue", "Owner", printer, "same-operation");
        expect(payload.type).toBe("pdf");
        expect(payload.protocol).toBeUndefined();
        expect(validatePrintJobPayload(payload)).toEqual(payload);
        expect(validatePayloadForPrinter(payload, printer).ok).toBe(true);
      }
    }
    const optedIn = { connectionType: "spooler", protocol: "escpos", capabilities: { supported_protocols: ["escpos"] } };
    const passthrough = buildTestPrintPayloadForPrinter("Explicit passthrough", "Owner", optedIn, "same-operation");
    expect(passthrough.type).toBe("escpos");
    expect(validatePayloadForPrinter(passthrough, optedIn).ok).toBe(true);
  });

  it("rejects diagnostics for unimplemented physical connections instead of inventing a byte sink", () => {
    for (const connectionType of ["", "unknown", "lpr", "serial", "bluetooth", "wsd", "snmp"]) {
      for (const protocol of ["raw", "escpos", "zpl", "tspl"]) {
        expect(() => buildTestPrintPayloadForPrinter("Candidate", "Owner", {
          connectionType, protocol, capabilities: { supported_protocols: [protocol] },
        }, "same-operation")).toThrow(/no supported test ticket format/i);
      }
    }
  });

  it("does not promote malformed capabilities or override a direct printer's declared language", () => {
    for (const supported_protocols of ["raw", null, true, { raw: true }]) {
      for (const connectionType of ["network", "spooler", "ipp"]) {
        expect(() => buildTestPrintPayloadForPrinter("Malformed", "Owner", {
          connectionType, protocol: "raw", capabilities: { supported_protocols },
        }, "same-operation")).toThrow(/no supported test ticket format/i);
      }
    }
    for (const supported_protocols of [[], ["zpl"], ["pdf"]]) {
      expect(() => buildTestPrintPayloadForPrinter("Declared RAW", "Owner", {
        connectionType: "network", protocol: "raw", capabilities: { supported_protocols },
      }, "same-operation")).toThrow(/no supported test ticket format/i);
    }
  });

  it("prints native or compact labels without changing calibrated stock or accepting injected commands", () => {
    for (const connectionType of ["network", "usb"]) {
      const build = (protocol: "zpl" | "tspl") => Buffer.from(buildTestPrintPayloadForPrinter(
        '^XZ~JA"\nSIZE 200 mm,200 mm', 'GAP 9 mm,9 mm', { connectionType, protocol }, "same-operation",
      ).data, "base64").toString("ascii");
      const tspl = build("tspl");
      expect(tspl).toBe("SELFTEST\r\n");
      expect(tspl).not.toMatch(/SIZE|GAP|CLS|INITIALPRINTER|PRINT 9/);
      const zpl = build("zpl");
      expect(zpl).toBe("^XA\n^FO4,4^A0N,12,12^FDTEST^FS\n^XZ\n");
      expect(zpl.match(/\^XA/g)).toHaveLength(1);
      expect(zpl.match(/\^XZ/g)).toHaveLength(1);
      expect(zpl).not.toMatch(/\^PW|\^LL|\^GB|~WC|~JA|SIZE|GAP/);
    }
  });

  it("retains all bounded wide office metadata inside the source PDF before driver scaling", () => {
    const name = "W".repeat(80);
    const operation = "W".repeat(60);
    const pdf = buildTestPdfPayload(name, name, operation);
    expect(pdf).toBe(buildTestPdfPayload(name, name, operation));
    expect(pdf).toContain("/MediaBox [0 0 612 792]");
    const lines = [...pdf.matchAll(/^\((.*)\) Tj$/gm)].map(match => match[1]);
    expect(lines[0]).toBe("YASEIR TEST PAGE");
    for (const line of lines.slice(1)) expect(line.length).toBeLessThanOrEqual(42);
    const body = lines.slice(1).join("");
    expect(body).toContain(`Printer: ${"W".repeat(60)}`);
    expect(body).toContain(`Agent: ${"W".repeat(60)}`);
    expect(body).toContain(`Status: OK | Operation ${operation}`);
    expect(body.match(/W/g)).toHaveLength(180);
    expect(690 - (lines.length - 2) * 20).toBeGreaterThan(50);
    const xrefOffset = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(xrefOffset)).toMatch(/^xref\n0 6\n/);
  });
});
