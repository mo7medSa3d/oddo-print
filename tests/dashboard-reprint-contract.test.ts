import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("dashboard reprint safety contract", () => {
  it("guards the reprint mutation with the shared busy state", () => {
    const source = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
    expect(source).toContain("const confirmReprint = async () => {");
    expect(source).toContain("if (!job || busy) return;");
    expect(source).toContain("setBusy(true);");
    expect(source).toContain("setBusy(false);");
    expect(source).toContain('onClick={() => void confirmReprint()}');
  });
});
