import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop attention counts include unknown and stale printers", () => {
  it("Overview counts unknown and stale printers as attention", () => {
    const overview = readFileSync("src/desktop/pages/Overview.tsx", "utf8");
    expect(overview).toContain("printerHealthCounts(shownPrinters, s.nowMs)");
    expect(overview).toContain("offline + unknownPrinters");
  });

  it("Overview printer stat surfaces unknown printers instead of ok", () => {
    const overview = readFileSync("src/desktop/pages/Overview.tsx", "utf8");
    expect(overview).toContain("offline + unknownPrinters");
    // Keyboard focus must stay visible on the printer row button.
    expect(overview).not.toContain("focus:outline-none");
    expect(overview).toContain("focus-visible:ring-");
  });
});
