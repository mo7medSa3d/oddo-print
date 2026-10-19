import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PLAN_ENTITLEMENT_KEYS } from "../src/lib/entitlements";

// H-3: every plan entitlement must resolve to a catalogued label in both
// locales so the Arabic billing surface never renders raw English.
describe("entitlement label coverage (H-3)", () => {
  it("maps every PLAN_ENTITLEMENT_KEYS member to a catalog key", () => {
    const page = readFileSync("src/app/billing/page.tsx", "utf8");
    for (const key of PLAN_ENTITLEMENT_KEYS) {
      if (key === "max_prints_per_period") {
        expect(page).toContain('t("billing.printJobsPerPeriod")');
        continue;
      }
      expect(page).toContain(`t("billing.entitlement.${key}")`);
    }
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
