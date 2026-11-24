import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { v4AdminEn, v4AdminAr } from "../src/i18n/messages/v4-admin";
import { v4OnboardingEn, v4OnboardingAr } from "../src/i18n/messages/v4-onboarding";
const read = (path: string) => readFileSync(path, "utf8");

describe("customer and Platform Admin subscription UX boundaries", () => {
  it("keeps approved requests as history rather than permanent success banners", () => {
    const actions = read("src/components/BillingActions.tsx");
    expect(actions).toContain("showRequestForm");
    expect(actions).toContain("request && <details");
    expect(actions).toContain('t("v4.subscription.lastRequest")');
    expect(actions).not.toContain('tone={request.status === "approved"');
    expect(actions).toContain('fetchWithTimeout("/api/subscription-requests"');
    expect(actions).toContain("idempotency.current");
  });
  it("only exposes real supported plan features in cards", () => {
    const pricing = read("src/app/pricing/page.tsx");
    const unified = read("src/components/UnifiedBillingView.tsx");
    expect(pricing).toContain("<UnifiedBillingView");
    expect(unified).toContain("v4.pricing.featureOdoo");
    expect(unified).toContain('<bdi dir="ltr">');
    for (const key of ["featureOdoo","featurePos","featureBranches","featureActivity"] as const) {
      expect(v4OnboardingAr["v4.pricing." + key as keyof typeof v4OnboardingAr]).toMatch(/\p{Script=Arabic}/u);
      expect(v4OnboardingEn["v4.pricing." + key as keyof typeof v4OnboardingEn]).toBeTruthy();
    }
  });
  it("navigates every subscription page with server-side status filtering", () => {
    const page = read("src/app/platform/subscriptions/page.tsx");
    expect(page).toContain("const PAGE_SIZE = 50;");
    expect(page).toContain("setOffset(0)");
    expect(page).toContain("setHasMore(data.hasMore)");
    expect(page).toContain("common.previousPage");
    expect(page).toContain("common.nextPage");
    expect(page).toContain("common.pageRange");
    expect(page).toContain("limit: String(PAGE_SIZE)");
    expect(page).toContain("status: status");
    expect(page).not.toContain("items.filter(item => status");
  });
  it("keeps usage ratios legible in RTL and offers safe manual termination without DELETE", () => {
    const listing = read("src/app/platform/subscriptions/page.tsx");
    const detail = read("src/app/platform/tenants/[id]/page.tsx");
    const editor = read("src/components/platform/SubscriptionEditor.tsx");
    const backend = read("src/app/api/platform/tenants/[id]/subscription/route.ts");
    const mutation = read("src/lib/manual-subscriptions.ts");
    expect(listing).toContain('bdi dir="ltr"');
    expect(listing).toContain("subscriptionAction=revoke");
    expect(listing).toContain('item.status === "active"');
    expect(listing).not.toContain('method: "DELETE"');
    expect(detail).toContain('searchParams.get("subscriptionAction")');
    expect(detail).toContain('const linkedRequest=!directAction && pending');
    expect(editor).toContain('preferredAction === "revoke"');
    // WP-G: call-site unification — same catalogue key, now via t() instead of a().
    expect(editor).toContain('t("v4.admin.endSubscriptionWarning")');
    expect(editor).not.toContain('"/api/platform/auth/reauth"');
    expect(editor).not.toContain('type="password"');
    expect(backend).toContain("requirePlatformOwner(req)");
    expect(backend).toContain("requireIdempotencyKey(req)");
    // v3 (0108): revoke was split from suspend — revoke sets a terminal
    // revokedAt marker and reactivate of a revoked contract throws
    // SUBSCRIPTION_REVOKED, because old revoke-identical-to-suspend let a
    // later reactivate silently undo it. Both actions remain handled.
    expect(mutation).toContain("input.action==='suspend'");
    expect(mutation).toContain("input.action==='revoke'");
    expect(mutation).toContain("revokedAt");
    expect(mutation).toContain("SUBSCRIPTION_REVOKED");
    expect(mutation).toContain("subscriptionChanges");
    for (const key of ["endSubscriptionNow","endSubscriptionWarning","usedOfQuota"] as const) {
      expect(v4AdminEn["v4.admin." + key as keyof typeof v4AdminEn]).toBeTruthy();
      expect(v4AdminAr["v4.admin." + key as keyof typeof v4AdminAr]).toMatch(/\p{Script=Arabic}/u);
    }
  });
});
