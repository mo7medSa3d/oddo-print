import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("billing renewal localization contract", () => {
  it("never hardcodes English renewal copy into the localized billing page", () => {
    const source = readFileSync("src/app/billing/page.tsx", "utf8");

    expect(source).not.toContain("`Renews ${formatDate(");
    expect(source).not.toContain("`Ends ${formatDate(");
    expect(source).not.toContain("`Ended ${formatDate(");

    expect(source).toContain('t("billing.renewsOn", { date: formatDate(sub.currentPeriodEnd) })');
    expect(source).toContain('t("billing.cancelScheduled", { date: formatDate(sub.currentPeriodEnd) })');
    expect(source).toContain('t("billing.periodEndsOn", { date: formatDate(sub.currentPeriodEnd) })');
  });
});
