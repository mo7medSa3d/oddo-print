import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { platformPlanMutationErrorKey as failure } from "../src/lib/platform-plan-errors";

describe("platform plan save failure feedback", () => {
  it("explains unregistered staging prices instead of suggesting a blind retry", () => {
    expect(failure(400, { code: "TEST_PRICE_NOT_IN_CATALOG" }))
      .toBe("platform.plans.error.testPriceNotCatalogued");
  });

  it("separates rejected Stripe binding from missing provider configuration", () => {
    expect(failure(400, { code: "STRIPE_PRICE_INVALID" }))
      .toBe("platform.plans.error.invalidStripePrice");
    expect(failure(503, { code: "STRIPE_NOT_CONFIGURED" }))
      .toBe("platform.plans.error.stripeNotConfigured");
    expect(failure(502, { code: "STRIPE_UNAVAILABLE" }))
      .toBe("platform.plans.error.stripeUnavailable");
  });

  it("shows specific validation, duplicate, optimistic-conflict and permission errors", () => {
    expect(failure(400, { error: "Plan name required" })).toBe("platform.plans.error.invalidFields");
    expect(failure(409, { code: "PLAN_EXISTS" })).toBe("platform.plans.error.exists");
    expect(failure(409, { code: "PLAN_CONFLICT" })).toBe("platform.plans.error.conflict");
    expect(failure(409, { code: "PLAN_CHANGED_RETRY" })).toBe("platform.plans.error.changed");
    expect(failure(403, { error: "Forbidden" })).toBe("platform.plans.error.unauthorized");
  });

  it("does not misdescribe unknown/ambiguous failures as definitive rejections", () => {
    expect(failure(500, { error: "DB timeout" })).toBe("platform.plans.saveFailed");
    expect(failure(504, null)).toBe("platform.plans.saveFailed");
  });

  it("the editor reads server response codes and rejects malformed IDs locally", () => {
    const page = readFileSync("src/app/platform/plans/page.tsx", "utf8");
    expect(page).toContain("platformPlanMutationErrorKey(res.status, failure)");
    expect(page).toContain("const failure = await res.json().catch(() => null)");
    expect(page).toContain('/^[a-z0-9][a-z0-9_-]{1,63}$/.test(form.id.trim())');
    expect(page).toContain('t("platform.plans.validation.displayOrder")');
  });
});
