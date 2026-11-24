import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// H-3: every plan entitlement must resolve to a catalogued label in both
// locales so the Arabic billing surface never renders raw English.
describe("entitlement label coverage (H-3)", () => {
  it("shows monthly jobs and unlimited commercial counts without infrastructure limits", () => {
    const page = readFileSync("src/app/billing/page.tsx", "utf8");
    const pricing = readFileSync("src/app/pricing/page.tsx", "utf8");
    const unified = readFileSync("src/components/UnifiedBillingView.tsx", "utf8");
    expect(page).toContain("customerSubscriptionState(");
    expect(page).toContain("<UnifiedBillingView");
    expect(unified).toContain("<BillingActions");
    expect(pricing).toContain("<UnifiedBillingView");
    expect(unified).not.toContain('Object.entries(plan.entitlements)');
    expect(unified).not.toContain('t("billing.entitlement.max_jobs_per_minute")');
  });
  it("has en+ar catalog entries for every mapped label", async () => {
    const { en } = await import("../src/i18n/messages/en");
    const { ar } = await import("../src/i18n/messages/ar");
    const expected: Record<string, true> = {
      "billing.printJobsPerPeriod": true,
      "billing.entitlement.max_agents": true,
      "billing.entitlement.max_printers": true,
      "billing.entitlement.max_jobs_per_minute": true,
      "billing.entitlement.max_concurrent_jobs": true,
    };
    for (const key of Object.keys(expected)) {
      expect((en as Record<string, unknown>)[key], `en ${key}`).toBeTruthy();
      expect((ar as Record<string, unknown>)[key], `ar ${key}`).toBeTruthy();
    }
  });
});
