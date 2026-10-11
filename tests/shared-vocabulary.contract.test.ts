import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { classifyJobFailure, jobFailurePresentation } from "../src/shared/job-vocabulary";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

// Shared Gateway vocabularies must have exactly one authority. These static
// pins stop the next enum-drift bug (the device-class Gateway/Agent drift
// class): if anyone re-declares a vocabulary instead of deriving it, or
// adds a runtime import that would drag node-only modules into the
// browser/desktop bundles, these tests fail before CI does.
describe("shared vocabulary single-authority contracts", () => {
  it("classifies pre-dispatch IPP and headless PDFium failures with bilingual action guidance", () => {
    const ipp = 'IPP printer http://192.168.8.34:631/ipp/print unreachable (request not sent): Post: dial tcp timeout';
    const pdf = 'PDF print on "POS80 Printer" failed: acquire embedded PDFium worker: could not instantiate webassembly module: GetFileType /dev/stdout: The handle is invalid.';
    expect(classifyJobFailure(ipp)).toBe("ipp_unreachable");
    expect(classifyJobFailure(pdf)).toBe("pdfium_headless");
    expect(jobFailurePresentation(ipp, "en")?.guidance).toContain("port 631");
    expect(jobFailurePresentation(ipp, "ar")?.guidance).toContain("631");
    expect(jobFailurePresentation(pdf, "en")?.guidance).toContain("service");
    expect(jobFailurePresentation(pdf, "ar")?.title).toContain("PDF");
    expect(classifyJobFailure('IPP printer X returned HTTP 500 (submission may have been accepted)')).toBeNull();
    expect(classifyJobFailure('UNKNOWN_PARTIAL_DELIVERY: print timed out')).toBeNull();
  });

  it("stale thresholds stay dependency-free for client bundles", () => {
    const source = read("src/lib/stale-threshold.ts");
    // Any runtime import here (db, pg, drizzle) would break the dashboard
    // and Tauri desktop builds that bundle job-vocabulary.
    expect(source).not.toMatch(/^import[\s{]/m);
    expect(source).toContain("export function agentStaleThresholdSeconds");
    expect(source).toContain("export function printerStaleThresholdSeconds");
  });

  it("capability vocabularies derive from the printer-model authority", () => {
    const source = read("src/lib/printer-capability.ts");
    expect(source).toContain('import type { PRINTER_PROTOCOLS, DEVICE_CLASSES, CONNECTION_TYPES } from "./printer-model"');
    expect(source).toContain("export type ProtocolType = (typeof PRINTER_PROTOCOLS)[number]");
    expect(source).toContain("export type DeviceClass = (typeof DEVICE_CLASSES)[number]");
    // No runtime import of the zod/node:net chain: this module ships in
    // the dashboard client and the desktop bundle.
    expect(source).not.toMatch(/^import \{[^}]*\} from "\.\/printer-model"/m);
  });

  it("routing byte protocols derive from the canonical protocol list", () => {
    const source = read("src/lib/printer-capability.ts");
    expect(source).toContain("payloadContract.rawProtocols");
    expect(source).not.toContain('const BYTE_PROTOCOLS = ["raw", "escpos", "zpl", "tspl"]');
  });

  it("agent-availability stays the canonical server-side threshold API", () => {
    const source = read("src/lib/agent-availability.ts");
    expect(source).toContain('from "./stale-threshold"');
  });

  it("shared UI vocabulary reads thresholds without the db chain", () => {
    const source = read("src/shared/job-vocabulary.ts");
    expect(source).toContain("../lib/stale-threshold");
    expect(source).not.toContain("../lib/agent-availability");
  });
  it("pins Gateway and Go device-class vocabularies to the same set", () => {
    const gateway = read("src/lib/printer-model.ts");
    const agent = read("agent/internal/agent/device_class.go");

    const gatewayMatch = gateway.match(/export const DEVICE_CLASSES = \[(.*?)\] as const;/s);
    const agentMatch = agent.match(/var gatewayDeviceClasses = map\[string\]struct\{\}*\{([\s\S]*?)\n\}/);
    expect(gatewayMatch).not.toBeNull();
    expect(agentMatch).not.toBeNull();

    const gatewayClasses = Array.from(gatewayMatch?.[1].matchAll(/"([^"]+)"/g) ?? [], (m) => m[1]).sort();
    const agentClasses = Array.from(agentMatch?.[1].matchAll(/"([^"]+)":/g) ?? [], (m) => m[1]).sort();
    expect(agentClasses).toEqual(gatewayClasses);
  });

});
