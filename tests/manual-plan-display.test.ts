import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("active subscription plan UX contract", () => {
  const pricing = readFileSync("src/app/pricing/page.tsx", "utf8");
  const billing = readFileSync("src/app/billing/page.tsx", "utf8");
  const admin = readFileSync("src/app/platform/plans/page.tsx", "utf8");
  const publicApi = readFileSync("src/app/api/billing/plans/route.ts", "utf8");

  it("routes authenticated customers with a live plan to their current subscription, not a comparison grid", () => {
    expect(pricing).toContain('if (claims && currentPlanId) redirect("/billing")');
    expect(pricing).toContain('isSubscriptionPeriodLive(subscription.currentPeriodEnd)');
    expect(billing).toContain('t("billing.currentPlan")');
  });

  it("includes manual prices in public catalogue and current-plan view without requiring Stripe IDs", () => {
    expect(pricing).toContain("priceAmount: plans.priceAmount");
    expect(pricing).toContain("formatPlanPriceAmount(plan.priceAmount, plan.currency, locale)");
    expect(publicApi).toContain("priceAmount: plans.priceAmount");
    expect(publicApi).not.toContain("isNotNull(plans.stripePriceId)");
    expect(billing).toContain("formatPlanPriceAmount(effectivePlan.priceAmount, effectivePlan.currency, locale)");
  });

  it("lets platform admins set USD/SAR amounts without posting Stripe associations", () => {
    expect(admin).toContain('value="usd"');
    expect(admin).toContain('value="sar"');
    expect(admin).toContain("priceAmount: form.priceAmount");
    expect(admin).not.toContain("stripePriceId: form.stripePriceId,");
  });
});
