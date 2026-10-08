import { describe, expect, it } from "vitest";
import { receiptRasterWidthDots } from "../src/lib/receipt-width";

describe("receipt raster print width comes from the actual device rather than browser DPI", () => {
  it("prefers true printable dots over nominal millimetres", () => {
    expect(receiptRasterWidthDots({ max_paper_width: 512, paper_width_mm: 80, dpi: 203 })).toBe(512);
    expect(receiptRasterWidthDots({ max_paper_width: 576, paper_width_mm: 80, dpi: 180 })).toBe(576);
    expect(receiptRasterWidthDots({ max_paper_width: "384" })).toBe(384);
  });
  it("understands 180dpi vs 203dpi 58/80mm paper without claiming the same width", () => {
    expect(receiptRasterWidthDots({ paper_width_mm: 80, dpi: 180 })).toBe(512);
    expect(receiptRasterWidthDots({ paper_width_mm: 80, dpi: 203 })).toBe(576);
    expect(receiptRasterWidthDots({ paper_width_mm: 58, dpi: 180 })).toBe(360);
    expect(receiptRasterWidthDots({ paper_width_mm: 58, dpi: 203 })).toBe(384);
  });
  it("does not guess from unknown widths, malicious strings, or unsupported resolution", () => {
    for (const v of [{ max_paper_width: 999999 }, { max_paper_width: "-1" },
      { paper_width_mm: 77 }, {}, null, { paper_widths: [58, "bad"] }]) {
      expect(receiptRasterWidthDots(v)).toBeNull();
    }
  });
  it("chooses the smallest advertised paper when no roll is actively selected", () => {
    expect(receiptRasterWidthDots({ paper_widths: [80, 58], dpi: 203 })).toBe(384);
    expect(receiptRasterWidthDots({ paper_widths: [80, 58], dpi: 180 })).toBe(360);
  });
});
