import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { v4OnboardingAr, v4OnboardingEn } from "../src/i18n/messages/v4-onboarding";
const read = (path: string) => readFileSync(path, "utf8");

describe("customer subscriptions are separate from Platform Admin approval", () => {
  it("workspace billing shows its own subscription and customer requests", () => {
    const billing = read("src/app/billing/page.tsx");
    expect(billing).toContain("verifyWorkspaceTokenFromCookieValues(");
    expect(billing).toContain("UnifiedBillingView");
    expect(read("src/components/UnifiedBillingView.tsx")).toContain("<BillingActions");
    expect(billing).toContain("customerSubscriptionState(");
    expect(billing).toContain('redirect("/login?next=%2Fbilling")');
    expect(billing).not.toContain('redirect("/platform/subscriptions")');
    const onboarding = read("src/app/onboarding/page.tsx");
    expect(onboarding).toContain('"/billing"');
    const requests = read("src/app/api/subscription-requests/route.ts");
    expect(requests).toContain("validateWorkspaceManager(req)");
    expect(requests).toContain('requireManagerActorInTransaction(tx,actor,"billing.read")');
    expect(requests).toContain("requireIdempotencyKey(req)");
  });
  it("public pricing uses only public plans while signed-in customers can choose a plan", () => {
    const pricing = read("src/app/pricing/page.tsx");
    expect(pricing).toContain("tenantSubscriptions.findFirst");
    expect(pricing).not.toContain("currentPlanId");
    // A signed-in pricing redirect cannot use an orphaned cookie snapshot:
    // unlike public plan cards, private subscription status needs live
    // membership, tenant lifecycle and session locks in the same transaction.
    expect(pricing).toContain("await db.transaction(async tx =>");
    expect(pricing).toContain("await requireActiveTenantInTransaction(tx, member.tenantId)");
    expect(pricing).toContain('await requireManagerActorInTransaction(tx, member, "tenant.read")');
    expect(pricing).toContain("tx.query.tenantSubscriptions.findFirst");
    expect(pricing).not.toContain("db.query.tenantSubscriptions.findFirst");
    expect(pricing).toContain("claims = null;");
    expect(pricing).toContain("if (claims && subscribed) redirect(");
    expect(pricing).toContain('<UnifiedBillingView');
    expect(read('src/components/UnifiedBillingView.tsx')).toContain('/billing${query}');
    const home = read("src/app/page.tsx");
    expect(home).toContain('const canBilling = hasManagerPermission(claims, "billing.read")');
    expect(home).toContain("const plan = canBilling && subscription");
    expect(home).toContain("customerSubscriptionState(subscription, tenant?.lifecycle, await databaseNowMs())");
  });
  it("manual activation is exclusive to Platform Owner while the customer can request", () => {
    const platform = read("src/app/api/platform/subscriptions/route.ts");
    expect(platform).toContain("requirePlatformOwner");
    const approval = read("src/app/api/platform/tenants/[id]/subscription/route.ts");
    expect(approval).toContain("requirePlatformOwner");
    expect(read("src/components/BillingActions.tsx")).toContain('fetchWithTimeout("/api/subscription-requests"');
    const usage = read("src/app/api/billing/usage/route.ts");
    expect(usage).toContain('requireManagerPermission(manager, "billing.read")');
  });
  it("keeps subscriptions and billing interval localized in both languages", () => {
    const labels = read("src/lib/billing-labels.ts");
    const en = read("src/i18n/messages/en.ts");
    const ar = read("src/i18n/messages/ar.ts");
    expect(labels).toContain("billingTermLabel");
    expect(labels).toContain('t("v4.onboarding.monthly")');
    for (const key of ["platform.plans.interval.month", "platform.plans.interval.year"]) {
      expect(en).toContain(`"${key}":`);
      expect(ar).toContain(`"${key}":`);
    }
    for (const key of ["v4.onboarding.monthly", "v4.onboarding.yearly", "v4.subscription.custom", "v4.subscription.notSet"] as const) {
      expect(v4OnboardingEn[key]).toBeTruthy();
      expect(v4OnboardingAr[key]).toMatch(/\p{Script=Arabic}/u);
    }
  });
  it("does not promise unlimited use while the subscription has finite quotas", () => {
    expect(read("src/i18n/messages/en.ts")).toContain("pricing.point1");
    expect(read("src/i18n/messages/en.ts")).not.toContain("you never hit a surprise stop");
  });
});
