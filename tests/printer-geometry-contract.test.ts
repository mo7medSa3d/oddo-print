import { describe, expect, it } from "vitest";
import fixtures from "../contracts/printer-geometry-fixtures.json";
import {
  capabilitiesWithCurrentGeometry,
  currentPrinterGeometry,
  printerGeometryFromCapabilities,
  hasPhysicalReceiptGeometry,
  validatePrinterGeometry,
  validatePrinterGeometryProfile,
} from "../src/lib/printer-geometry";
import { validatePayloadForPrinter } from "../src/lib/printer-capability";
import { validatePrintJobPayload } from "../src/lib/payload";

describe("shared printer geometry fixtures", () => {
  for (const fixture of fixtures.geometryCases) {
    it(fixture.name, () => {
      const parsed = validatePrinterGeometry(fixture.geometry, "expected" in fixture ? fixture.expected : undefined);
      expect(parsed.ok).toBe(fixture.valid);
      if (parsed.ok) {
        expect(parsed.value.printable_width_dots).toBe(fixture.rasterWidth);
        expect(hasPhysicalReceiptGeometry(parsed.value)).toBe(fixture.physical);
      }
    });
  }
  for (const fixture of fixtures.profileCases) {
    it(`desired profile: ${fixture.name}`, () => {
      expect(validatePrinterGeometryProfile(fixture.profile).ok).toBe(fixture.valid);
    });
  }
  for (const fixture of fixtures.payloadCases) {
    it(`payload admission: ${fixture.name}`, () => {
      expect(validatePayloadForPrinter(fixture.payload, fixture.printer).ok).toBe(fixture.allowed);
    });
  }

  it("keeps geometry evidence behind the exact Gateway printer ID wire boundary", () => {
    // This result is consumed by Odoo and Gateway, while the native Agent
    // sends an opaque UTF-8 printer ID. Never validate this evidence using
    // JS UTF-16 code units or repair an invalid identity by normalization.
    const evidence = fixtures.geometryCases[0].geometry;
    const cases: Array<[string, string, boolean]> = [
      ["Arabic at 120 UTF-8 bytes", "ط".repeat(60), true],
      ["Arabic above 120 UTF-8 bytes", "ط".repeat(61), false],
      ["Emoji at 120 UTF-8 bytes", "🖨".repeat(30), true],
      ["Emoji above 120 UTF-8 bytes", "🖨".repeat(31), false],
      ["leading BOM", "\uFEFFprinter", false],
      ["lone high surrogate", "\uD800", false],
      ["interior BOM is opaque", "prin\uFEFFter", true],
    ];
    for (const [name, printerId, valid] of cases) {
      const observed = { ...evidence, printer_id: printerId };
      expect(validatePrinterGeometry(observed).ok, name).toBe(valid);
      const recovered = printerGeometryFromCapabilities({ geometry: observed });
      expect(recovered !== null, name + " capability projection").toBe(valid);
    }
  });

  it("does not coerce non-finite numbers or objects into physical measurements", () => {
    const base = fixtures.geometryCases[0].geometry;
    for (const value of [NaN, Infinity, -Infinity, [], {}, { valueOf: () => 576 }]) {
      expect(validatePrinterGeometry({ ...base, printable_width_dots: value }).ok).toBe(false);
    }
  });

  it("does not expose geometry until both applied and observed desired state converge", () => {
    const base = { id: "receipt-printer", capabilities: { geometry: fixtures.geometryCases[0].geometry, supported_protocols: ["escpos"] }, config: { geometry_profile: { printable_width_dots: 576, raster_command: "gs_v_0" } }, managementSource: "manager", desiredRevision: 3 };
    expect(currentPrinterGeometry({ ...base, appliedDesiredRevision: 2, observedDesiredRevision: 2 })).toBeNull();
    expect(currentPrinterGeometry({ ...base, appliedDesiredRevision: 3, observedDesiredRevision: 2 })).toBeNull();
    expect(currentPrinterGeometry({ ...base, appliedDesiredRevision: 3, observedDesiredRevision: 3 })?.printable_width_dots).toBe(576);
    expect(capabilitiesWithCurrentGeometry(base)).toEqual({ supported_protocols: ["escpos"] });
  });

  it("drops stale configured geometry after the operator removes its profile", () => {
    const geometry = fixtures.geometryCases[0].geometry;
    const state = {
      id: geometry.printer_id,
      capabilities: { geometry, supported_protocols: ["escpos"] },
      config: {},
      managementSource: "manager",
      desiredRevision: 4,
      appliedDesiredRevision: 4,
      observedDesiredRevision: 4,
    };
    expect(currentPrinterGeometry(state)).toBeNull();
    expect(capabilitiesWithCurrentGeometry(state)).toEqual({ supported_protocols: ["escpos"] });
    expect(currentPrinterGeometry({ ...state, config: {
      geometry_profile: { printable_width_dots: 576, raster_command: "gs_v_0" },
    } })?.printable_width_dots).toBe(576);
    expect(currentPrinterGeometry({ ...state, config: {
      geometry_profile: { printable_width_dots: 384, raster_command: "gs_v_0" },
    } })).toBeNull();
  });

  it("hides a pre-alias geometry without rewriting its Agent provenance", () => {
    const value = fixtures.geometryCases[0].geometry;
    expect(currentPrinterGeometry({ id: "receipt-printer~deadbeef", capabilities: { geometry: value } })).toBeNull();
    expect(value.printer_id).toBe("receipt-printer");
  });

  it("preserves the image fingerprint at the durable payload boundary", () => {
    const image = { type: "image", encoding: "base64", data: Buffer.from([255, 216, 255, 0]).toString("base64") };
    const geometry_fingerprint = fixtures.geometryCases[0].geometry.config_fingerprint;
    expect(validatePrintJobPayload(image).geometry_fingerprint).toBeUndefined();
    expect(validatePayloadForPrinter(image, fixtures.payloadCases[0].printer).ok).toBe(false);
    expect(validatePrintJobPayload({ ...image, geometry_fingerprint }).geometry_fingerprint).toBe(geometry_fingerprint);
    expect(() => validatePrintJobPayload({ ...image, geometry_fingerprint: "bad" })).toThrow(/SHA256/);
    expect(() => validatePrintJobPayload({ type: "raw", protocol: "escpos", encoding: "base64", data: "eA==", geometry_fingerprint })).toThrow(/only applicable/);
  });
});
