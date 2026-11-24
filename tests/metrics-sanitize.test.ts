import { describe, it, expect } from "vitest";
import { formatCounterLine } from "../src/lib/metrics";

describe("metrics counter sanitization (I-1)", () => {
  it("formats valid counters", () => {
    expect(formatCounterLine("ok_total", 3)).toBe("ok_total 3");
  });
  it("rejects malformed names", () => {
    expect(formatCounterLine("bad name!", 1)).toBeNull();
    expect(formatCounterLine("ok\ninjected", 1)).toBeNull();
  });
  it("rejects non-numeric values", () => {
    expect(formatCounterLine("ok", "not-a-number")).toBeNull();
    expect(formatCounterLine("ok", NaN)).toBeNull();
    expect(formatCounterLine("ok", Infinity)).toBeNull();
  });
});
