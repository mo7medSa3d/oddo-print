import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop localized date direction", () => {
  it("uses locale-aware timestamps for recent jobs without forcing left-to-right date text", () => {
    const code = readFileSync("src/desktop/main.tsx", "utf8");
    expect(code).toContain('formatDateTime(jobTimestamp(selectedJob, "updatedAt"))');
    expect(code).not.toContain('dir="ltr">{formatDateTime');
  });
});
