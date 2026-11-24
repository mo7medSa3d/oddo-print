import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("License-Only Gateway removes legacy printer capability route", () => {
  it("does not expose /api/printers/capabilities on the Gateway", () => {
    expect(existsSync(join(process.cwd(), "src/app/api/printers/capabilities/route.ts"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/app/api/printers"))).toBe(false);
  });
});
