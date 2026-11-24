// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirFor } from "../src/i18n/config";

// J-1 partial (no browser harness exists yet): lock server/client RTL
// agreement so an Arabic session can never render a left-to-right layout.
describe("RTL agreement (J-1 partial)", () => {
  it("maps ar to rtl and en to ltr", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
  });
  it("pre-paint script agrees with the server helper", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(layout).toContain('root.dir=(locale==="ar")?"rtl":"ltr"');
    expect(layout).toContain("dir={dirFor(locale)}");
    expect(layout).toContain('root.lang=locale');
  });
});
