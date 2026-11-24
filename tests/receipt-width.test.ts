import { describe, expect, it } from "vitest";
import fixtures from "../contracts/printer-geometry-fixtures.json";
import { receiptPaperWidthMM, receiptRasterWidthDots } from "../src/lib/receipt-width";

describe("receipt raster print width comes from the actual device rather than browser DPI", () => {
  it("only generates physical receipt media from a selected or unambiguous reported roll", () => {
    expect(receiptPaperWidthMM({ paper_width_mm: "80", paper_widths: [58, 80] })).toBe(80);
    expect(receiptPaperWidthMM({ paper_width_mm: 58.0 })).toBe(58);
    expect(receiptPaperWidthMM({ paper_width_mm: 79 })).toBe(79);
    expect(receiptPaperWidthMM({ paper_width_mm: 79.5 })).toBe(79.5);
    expect(receiptPaperWidthMM({ paper_width_mm: "79.5" })).toBe(79.5);
    expect(receiptPaperWidthMM({ paper_widths: [58] })).toBe(58);
    for (const caps of [null, {}, { max_paper_width: 576 }, { paper_widths: [58, 80] },
      { paper_width_mm: true }, { paper_width_mm: 39.9 }, { paper_width_mm: 120.1 }, { paper_widths: [null] },
      { paper_width_mm: 210, paper_widths: [58] }, { paper_width_mm: "bad", paper_widths: [80] }]) {
      expect(receiptPaperWidthMM(caps)).toBeNull();
    }
  });
  it("reads each verified fixture without a 576-dot ceiling", () => {
    for (const fixture of fixtures.geometryCases.filter((entry) => entry.valid)) {
      expect(receiptRasterWidthDots({ geometry: fixture.geometry })).toBe(fixture.rasterWidth);
    }
  });

  it("requires deliberate Agent migration of legacy dot labels", () => {
    for (const value of [58, 80, 128, 384, 512, 576, 832, 850, 1664, 1700, "384"]) {
      expect(receiptRasterWidthDots({ max_paper_width: value })).toBeNull();
    }
  });

  it("does not guess from nominal rolls, advertised media or DPI", () => {
    for (const caps of [{ paper_width_mm: 80, dpi: 180 }, { paper_width_mm: 58, dpi: 203 },
      { paper_widths: [80, 58], dpi: 600 }, { paper_widths: [80], dpi: 203 },
      { paper_width_mm: "80", dpi: "203" }, {}, null]) {
      expect(receiptRasterWidthDots(caps)).toBeNull();
    }
  });

  it("never invokes object coercion on untrusted observation bags", () => {
    const invalid = JSON.parse('{"toString":false,"valueOf":false}');
    for (const caps of [{ dpi: invalid, paper_width_mm: 80 }, { paper_width_mm: invalid },
      { paper_widths: [invalid] }, { geometry: invalid }, { geometry: [] }, { paper_width_mm: [80] }]) {
      expect(receiptRasterWidthDots(caps)).toBeNull();
    }
  });
});
