import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSubscriptionPeriodLive } from "../src/lib/entitlements";

const billing = readFileSync("src/app/billing/page.tsx", "utf8");
const home = readFileSync("src/app/page.tsx", "utf8");
const api = readFileSync("src/app/api/platform/subscriptions/route.ts", "utf8");
const ui = readFileSync("src/app/platform/subscriptions/page.tsx", "utf8");
const status = readFileSync("src/app/api/billing/status/route.ts", "utf8");

describe("expired trials remain identifiable but never entitled", () => {
  it("rejects the confirmed staging expiry with the same billing time predicate", () => {
    const expires = new Date("2026-10-18T23:51:02.856Z");
    expect(isSubscriptionPeriodLive(expires, expires.getTime() - 1)).toBe(true);
    expect(isSubscriptionPeriodLive(expires, expires.getTime())).toBe(false);
    expect(isSubscriptionPeriodLive(expires, Date.parse("2026-10-19T03:15:00Z"))).toBe(false);
  });

  it("never reports an expired quota as an unavailable backend", () => {
    expect(billing).toContain("if (hasActivePlan) {");
    expect(billing).toContain('label: t("billing.trialExpired")');
    expect(billing).toContain('t("billing.trialExpiredBody")');
    expect(billing).toContain("const effectivePlan = hasActivePlan ? currentPlan : null");
  });

  it("retains expired plan names only with clear ended labeling", () => {
    expect(billing).toContain("effectivePlan?.name ?? (currentPlan");
    expect(home).toContain('trialExpired ? t("billing.trialExpired")');
    expect(home).toContain("const hasPlan = !!planName && hasActiveSubscription");
    expect(status).toContain("const periodExpired = !!sub");
    expect(status).toContain('includePlanName && hasManagerPermission(manager, "billing.read") && sub');
  });

  it("uses the database clock for platform active and attention filters", () => {
    expect(api).toContain("clock_timestamp()");
    expect(api).toContain("periodExpired: sql<boolean>");
    expect(api).toContain("hasBillingAccess: sql<boolean>");
    expect(api).toContain("OR ${periodExpired}");
    expect(ui).toContain("s.periodExpired ||");
    expect(ui).toContain("s.hasBillingAccess &&");
    expect(ui).toContain("if (sub.periodExpired)");
  });

  it("does not change Stripe or printing entitlement admission", () => {
    expect(status).toContain("const hasSubscription =");
    expect(status).toContain("!sub.entitlementBlocked && isBillingAccessStatus(sub.status)");
    const usage = readFileSync("src/app/api/billing/usage/route.ts", "utf8");
    expect(usage).toContain('requireManagerPermission(manager, "billing.read")');
  });
});
