import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("billing status authorization contract", () => {
  it("requires the billing.read permission before exposing subscription status", () => {
    const source = readFileSync("src/app/api/billing/status/route.ts", "utf8");
    expect(source).toContain('requireManagerPermission(manager, "billing.read")');
    expect(source).toContain('return NextResponse.json({ error: "Forbidden" }, { status: 403 });');
    expect(source).toContain('"Cache-Control": "no-store"');
  });
});
