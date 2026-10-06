import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Billing truthfulness (C055/C064): return navigation is processing
// information until verified subscription state confirms payment; the stored
// plan row is history unless the subscription is live; intervals and quotas
// render honestly in both languages.
describe("billing confirmation evidence and localization", () => {
  it("treats checkout=success as processing until verified state confirms", () => {
    const page = readFileSync("src/app/billing/page.tsx", "utf8");
    expect(page).toContain("checkoutState === \"success\" && hasActivePlan && hasStripeSubscription");
    expect(page).toContain("checkoutState === \"success\" && !(hasActivePlan && hasStripeSubscription)");
    expect(page).not.toMatch(/\{\s*checkoutState === "success" && \(\s*\n/);
  });

  it("scopes the displayed current plan to a live subscription", () => {
    const page = readFileSync("src/app/billing/page.tsx", "utf8");
    const pricing = readFileSync("src/app/pricing/page.tsx", "utf8");
    expect(page).toContain("const effectivePlan = hasActivePlan ? currentPlan : null");
    expect(page).toContain("effectivePlan?.name");
    expect(pricing).toContain("trialing");
  });

  it("translates intervals instead of rendering raw enums", () => {
    const labels = readFileSync("src/lib/billing-labels.ts", "utf8");
    const en = readFileSync("src/i18n/messages/en.ts", "utf8");
    const ar = readFileSync("src/i18n/messages/ar.ts", "utf8");
    expect(labels).toContain("platform.plans.interval");
    for (const key of ["platform.plans.interval.month", "platform.plans.interval.year"]) {
      expect(en).toContain(`"${key}":`);
      expect(ar).toContain(`"${key}":`);
    }
    const billing = readFileSync("src/app/billing/page.tsx", "utf8");
    expect(billing).toContain("billingIntervalLabel(");
    expect(billing).not.toContain("currentPlan?.interval ?? ");
  });

  it("describes quotas as finite instead of promising no surprise stops", () => {
    const en = readFileSync("src/i18n/messages/en.ts", "utf8");
    expect(en).toContain("pricing.point1");
    expect(en).not.toContain("you never hit a surprise stop");
  });
});
