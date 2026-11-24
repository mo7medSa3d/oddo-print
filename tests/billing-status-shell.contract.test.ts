import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasManagerPermission } from "../src/lib/authorization";
const status = readFileSync("src/app/api/billing/status/route.ts", "utf8");
const shell = readFileSync("src/components/AppShell.tsx", "utf8");
const usage = readFileSync("src/app/api/billing/usage/route.ts", "utf8");

describe("customer billing scope and bounded status", () => {
  it("only polls service availability on shell mount, never protected quota", () => {
    expect(shell).toContain('fetchWithTimeout("/api/billing/status?includePlanName=1"');
    expect(shell).not.toContain('fetchWithTimeout("/api/billing/usage"');
    expect(status).toContain("customerSubscriptionState(");
  });
  it("only returns the optional sidebar plan label and hides subscription commercial fields", () => {
    expect(status).toContain('get("includePlanName") === "1"');
    expect(status).toContain("includePlanName && subscription");
    expect(status).toContain('...(includePlanName ? { planName: plan?.name ?? null } : {})');
    expect(status).toContain('columns: { name: true }');
    expect(status).not.toContain("monthlyQuota");
    expect(status).not.toContain("planId:");
    expect(status).toContain("Cache-Control");
    expect(status).toContain('member.role === "owner" ? { currentPeriodEnd:');
    expect(status).not.toContain("priceMinorUnits");
  });
  it("only the workspace owner can read commercial usage, not activate a plan", () => {
    expect(usage).toContain('requireManagerPermission(manager, "billing.read")');
    expect(hasManagerPermission({ role: "owner" } as Parameters<typeof hasManagerPermission>[0], "billing.read")).toBe(true);
    expect(hasManagerPermission({ role: "owner" } as Parameters<typeof hasManagerPermission>[0], "billing.manage")).toBe(false);
    for (const role of ["admin","viewer","operator","billing_admin","integration_admin"]) {
      expect(hasManagerPermission({ role } as Parameters<typeof hasManagerPermission>[0], "billing.read")).toBe(false);
    }
  });
});
