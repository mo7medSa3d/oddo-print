import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("License-Only Gateway removes legacy /api/printers routes", () => {
  it("keeps printer desired-state ownership in Odoo instead of Gateway routes", () => {
    expect(existsSync(join(process.cwd(), "src/app/api/printers/route.ts"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/app/api/printers/[id]/route.ts"))).toBe(false);
  });
});
