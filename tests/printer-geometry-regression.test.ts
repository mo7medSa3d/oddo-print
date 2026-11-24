import { describe, expect, it } from "vitest";
import { receiptRasterWidthDots } from "../src/lib/receipt-width";
import { validatePayloadForPrinter } from "../src/lib/printer-capability";

const fingerprint = "a".repeat(64);
const geometry = (dots = 576) => ({
  version: 1, source: "validated_profile", validation: "configured",
  observed_at: "2026-10-24T12:00:00Z", printer_id: "receipt-printer",
  config_fingerprint: fingerprint, printable_width_dots: dots, raster_command: "gs_v_0",
});

describe("printer geometry regression: never infer physical output from roll labels", () => {
  it.each([58, 80])("leaves a nominal %s mm roll without measured dots unknown", (mm) => {
    expect(receiptRasterWidthDots({ paper_width_mm: mm, dpi: 203 })).toBeNull();
  });

  it.each([832, 850, 1664, 1700])("preserves a verified %s-dot profile", (dots) => {
    expect(receiptRasterWidthDots({ geometry: geometry(dots) })).toBe(dots);
  });

  it("supports a direct USB GS v 0 raster only with its verified current profile", () => {
    expect(validatePayloadForPrinter({ type: "image", geometry_fingerprint: fingerprint }, {
      id: "receipt-printer", connectionType: "usb", protocol: "escpos",
      config: { geometry_profile: { printable_width_dots: 576, raster_command: "gs_v_0" } },
      capabilities: { geometry: geometry(), supported_protocols: ["escpos", "image"] },
    }).ok).toBe(true);
  });

  it("rejects a stale receipt layout even when the printer language is still ESC/POS", () => {
    expect(validatePayloadForPrinter({ type: "image", geometry_fingerprint: "b".repeat(64) }, {
      id: "receipt-printer", connectionType: "network", protocol: "escpos",
      config: { geometry_profile: { printable_width_dots: 576, raster_command: "gs_v_0" } },
      capabilities: { geometry: geometry(), supported_protocols: ["escpos", "image"] },
    }).ok).toBe(false);
  });

  it("does not treat the ESC/POS language label as proof of a raster command", () => {
    expect(validatePayloadForPrinter({ type: "image" }, {
      connectionType: "network", protocol: "escpos", capabilities: { supported_protocols: ["escpos"] },
    }).ok).toBe(false);
  });
});
