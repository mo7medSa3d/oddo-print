import { describe, expect, it } from "vitest";
import { formatPlanPriceAmount, parsePlanCurrency, parsePlanPriceAmount } from "../src/lib/plan-pricing";

describe("manual plan prices", () => {
  it("normalizes exact two-decimal prices without floating point rounding", () => {
    expect(parsePlanPriceAmount("0")).toBe("0.00");
    expect(parsePlanPriceAmount("49.5")).toBe("49.50");
    expect(parsePlanPriceAmount("120.00")).toBe("120.00");
    expect(parsePlanPriceAmount("9999999999.99")).toBe("9999999999.99");
  });

  it("rejects invalid or ambiguous price inputs", () => {
    for (const value of [undefined, null, -1, 10.25, "", "1e4", "10.999", "-4", "12abc", "10000000000", "NaN", "1,000"]) {
      expect(() => parsePlanPriceAmount(value)).toThrow();
    }
  });

  it("allows only USD and SAR, with canonical lowercase storage", () => {
    expect(parsePlanCurrency("USD")).toBe("usd");
    expect(parsePlanCurrency(" sar ")).toBe("sar");
    for (const value of ["EGP", "usd,eur", "", undefined, 123]) {
      expect(() => parsePlanCurrency(value)).toThrow();
    }
  });

  it("renders the saved amount with the selected currency in Arabic and English", () => {
    expect(formatPlanPriceAmount("99.50", "usd", "en")).toContain("99.50");
    expect(formatPlanPriceAmount("99.50", "usd", "en")).toMatch(/\$|USD/);
    expect(formatPlanPriceAmount("99.50", "sar", "en")).toMatch(/SAR|SAR\b/);
    expect(formatPlanPriceAmount("99.50", "sar", "ar")).toMatch(/ر\.س|SAR|ريال/);
    expect(formatPlanPriceAmount(null, "sar", "ar")).toBeNull();
    expect(formatPlanPriceAmount("99.50", "eur", "en")).toBeNull();
  });
});
