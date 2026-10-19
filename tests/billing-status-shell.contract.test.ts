import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasManagerPermission } from "../src/lib/authorization";

const status = readFileSync("src/app/api/billing/status/route.ts", "utf8");
const shell = readFileSync("src/components/AppShell.tsx", "utf8");
const usage = readFileSync("src/app/api/billing/usage/route.ts", "utf8");

describe("console plan summary and billing permission boundaries", () => {
  it("uses a lightweight status summary instead of calling the quota endpoint on every mount", () => {
    expect(shell).toContain('fetchWithTimeout("/api/billing/status?includePlanName=1"');
    expect(shell).not.toContain('fetchWithTimeout("/api/billing/usage"');
    expect(shell).toContain('data.hasSubscription && typeof data.planName === "string"');
  });

  it("only reads and returns a plan name for a live subscription and billing.read manager", () => {
    expect(status).toContain('includePlanName = new URL(req.url).searchParams.get("includePlanName") === "1"');
    expect(status).toContain('includePlanName && hasSubscription && hasManagerPermission(manager, "billing.read") && sub');
    expect(status).toContain('where: eq(plans.id, sub.planId)');
    expect(status).toContain('...(includePlanName ? { planName: currentPlan?.name ?? null } : {})');
    expect(status).toContain('"Cache-Control": "no-store"');
    expect(status).toContain('!sub.entitlementBlocked && isBillingAccessStatus(sub.status)');
  });

  it("keeps the protected usage endpoint denied to managers without billing.read", () => {
    expect(usage).toContain('requireManagerPermission(manager, "billing.read")');
    expect(usage).toContain('{ status: 403 }');
    const billingReaders = ["owner", "admin", "billing_admin"];
    const nonReaders = ["operator", "viewer", "integration_admin"];
    for (const role of billingReaders) {
      expect(hasManagerPermission({ role } as Parameters<typeof hasManagerPermission>[0], "billing.read")).toBe(true);
    }
    for (const role of nonReaders) {
      expect(hasManagerPermission({ role } as Parameters<typeof hasManagerPermission>[0], "billing.read")).toBe(false);
    }
  });
});
