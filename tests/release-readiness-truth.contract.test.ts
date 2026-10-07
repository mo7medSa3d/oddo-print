import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("release-readiness truth contracts", () => {
  it("does not hard-code source implementation as PASS and surfaces health observation failures", () => {
    const source = fs.readFileSync("src/app/release-readiness/release-readiness-client.tsx", "utf8");
    expect(source).not.toContain('implemented: "PASS"');
    expect(source).toContain('sourceEvidence: "DOCUMENTED"');
    expect(source).toContain('sourceEvidence: "MISSING"');
    expect(source).toContain("systemHealthError");
    expect(source).toContain("fetchWithTimeout");
    expect(source).not.toContain("Leave the live section hidden");
  });

  it("keeps uncertain lifecycle and plan-impact copy evidence scoped", () => {
    const en = fs.readFileSync("src/i18n/messages/en.ts", "utf8");
    expect(en).toContain("couldn’t confirm whether the tenant lifecycle change was applied");
    expect(en).not.toContain("The tenant lifecycle action failed. No change was applied.");
    expect(en).toContain("entitlement changes affect current subscribers immediately");
    expect(en).toContain("Stripe price, currency, and billing interval changes apply to future checkouts only");
    expect(en).toContain('"release.complianceTitle": "Compliance notes"');
    expect(en).not.toContain("Compliance notes (honest)");
    expect(en).not.toContain("Prices and limits are unchanged");
    expect(en).not.toContain("No changes made. You can try again anytime.");
    expect(en).not.toContain("capabilities are restricted to 21");

    const ar = fs.readFileSync("src/i18n/messages/ar.ts", "utf8");
    expect(ar).toContain("تفصل هذه الصفحة بين أدلة مراجعة المصدر والتحقّق الفعلي المطلوب قبل الإصدار");
    expect(ar).toContain("وتبقى أي بوابة غير متحقَّق منها أو محظورة ظاهرة حتى تُثبت في البيئة المستهدفة");
    expect(ar).not.toContain("المطلوبان قبل الإصدار");
    expect(ar).not.toContain("ولا تعرض السياسة نجاحًا زائفًا");
  });
});
