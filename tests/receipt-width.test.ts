import { describe, expect, it } from "vitest";
import { receiptPaperWidthMM, receiptRasterWidthDots } from "../src/lib/receipt-width";

describe("receipt raster print width comes from the actual device rather than browser DPI", () => {
  it("only generates physical receipt media from a selected or unambiguous reported roll", () => {
    expect(receiptPaperWidthMM({ paper_width_mm: "80", paper_widths: [58, 80] })).toBe(80);
    expect(receiptPaperWidthMM({ paper_widths: [58] })).toBe(58);
    for (const caps of [null, {}, { max_paper_width: 576 }, { paper_widths: [58, 80] },
      { paper_width_mm: true }, { paper_width_mm: 77 }, { paper_widths: [null] },
      { paper_width_mm: 210, paper_widths: [58] }, { paper_width_mm: "bad", paper_widths: [80] }]) {
      expect(receiptPaperWidthMM(caps)).toBeNull();
    }
  });
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
  it("rejects absent or malformed roll dimensions rather than treating null as zero", () => {
    expect(receiptRasterWidthDots({ paper_width_mm: null, paper_widths: [80], dpi: 203 })).toBe(576);
    expect(receiptRasterWidthDots({ paper_width_mm: "", paper_widths: [58], dpi: 203 })).toBe(384);
    expect(receiptRasterWidthDots({ paper_widths: [null, 80], dpi: 203 })).toBeNull();
    expect(receiptRasterWidthDots({ max_paper_width: " 384 " })).toBe(384);
    expect(receiptRasterWidthDots({ max_paper_width: "3.84e2" })).toBeNull();
  });
});
