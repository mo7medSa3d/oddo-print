import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { v4OnboardingAr, v4OnboardingEn } from "../src/i18n/messages/v4-onboarding";

describe("billing renewal localization contract", () => {
  it("keeps Workspace Owner invitations separate from Platform Owner plan activation in en/ar", () => {
    const teamPage = readFileSync("src/app/team/page.tsx", "utf8");
    const inviteGuard = readFileSync("src/lib/workspace-owner-invitations.ts", "utf8");
    expect(teamPage).toContain('profile?.role === "owner"');
    expect(inviteGuard).toContain('claims.role !== "owner"');

    const enOwner = v4OnboardingEn["v4.team.ownerOnly"];
    const arOwner = v4OnboardingAr["v4.team.ownerOnly"];
    expect(enOwner).toContain("Workspace Owner");
    expect(enOwner).not.toContain("Platform Owner");
    expect(arOwner).toContain("مالك مساحة العمل");
    expect(arOwner).not.toContain("مالك المنصة");

    const enScope = v4OnboardingEn["v4.team.fullAccessBody"];
    const arScope = v4OnboardingAr["v4.team.fullAccessBody"];
    expect(enScope).toMatch(/Workspace Owner.*Platform Owner/);
    expect(arScope).toContain("مالك مساحة العمل");
    expect(arScope).toContain("مالك المنصة");
    expect(v4OnboardingEn["v4.subscription.manualRenewal"]).toMatch(/Platform Owner/);
  });
  it("never hardcodes English renewal copy into the localized billing page", () => {
    const source = readFileSync("src/app/billing/page.tsx", "utf8");

    expect(source).not.toContain("`Renews ${formatDate(");
    expect(source).not.toContain("`Ends ${formatDate(");
    expect(source).not.toContain("`Ended ${formatDate(");

    expect(source).not.toContain('t("billing.renewsOn"');
    expect(source).toContain("currentPeriodEnd");
    expect(source).toContain("BillingActions");
    expect(source).not.toContain('redirect("/platform/subscriptions")');
    const platform = readFileSync("src/components/platform/SubscriptionEditor.tsx", "utf8");
    // WP-G: updated for WP-B+C+F call-site unification (a() was literally t("v4.admin."+key));
    // the dynamic option labels now resolve through t() with the same catalogue keys.
    expect(platform).toContain("t(`v4.admin.${v}` as MessageKey)");
    const calendarDates = readFileSync("src/lib/manual-calendar-date.ts", "utf8");
    expect(calendarDates).toContain("intlLocale(locale)");
    expect(calendarDates).toMatch(/timeZone:\s*['"]UTC['"]/);
    for (const key of ["v4.subscription.endsAtTerm", "v4.subscription.manualRenewal"] as const) {
      expect(v4OnboardingEn[key]).toMatch(/Platform Owner/);
      expect(v4OnboardingAr[key]).toMatch(/\p{Script=Arabic}/u);
    }
    expect(v4OnboardingEn["v4.subscription.manualRenewal"]).toMatch(/no automatic charge or automatic renewal/i);
    for (const key of ["v4.subscription.quotaBlockedTitle", "v4.subscription.quotaBlockedBody", "v4.subscription.quotaBlockedAction", "v4.subscription.expiringSoonTitle", "v4.subscription.expiringSoonBody", "v4.subscription.renewalDoesNotReset", "v4.subscription.legacyEndMissingTitle", "v4.subscription.legacyEndMissingBody"] as const) {
      expect(v4OnboardingEn[key]).toBeTruthy();
      expect(v4OnboardingAr[key]).toMatch(/\p{Script=Arabic}/u);
    }
  });
});
