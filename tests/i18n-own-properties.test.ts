import { describe, expect, it } from "vitest";
import { documentTypeLabel } from "../src/shared/document-label";
import { translate, translateCount } from "../src/i18n/translate";
import { lifecycleLabel } from "../src/lib/lifecycle-labels";
import type { MessageKey } from "../src/i18n/messages/en";

describe("translation prototype boundaries", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("renders unknown %s safely", key => {
    expect(translate("ar", key as MessageKey, { count: 2 })).toBe("النص غير متاح");
    expect(translateCount("ar", key, 2)).toBe("النص غير متاح");
    expect(lifecycleLabel(k => k, key)).toBe("lifecycle.active");
  });
  it("keeps real locale plural categories and interpolation", () => {
    expect(translateCount("ar", "printer.count", 2)).toBe("طابعتان");
    expect(translateCount("ar", "printer.count", 3)).toBe("3 طابعات");
    expect(translate("en", "auth.signIn.workspaceSuffix", { suffix: "123456" })).toBe("Workspace …123456");
  });
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("preserves unknown document name %s as text in both languages", value => {
    for (const locale of ["en", "ar"] as const) {
      const label = documentTypeLabel(value, locale);
      expect(typeof label).toBe("string");
      expect(label).toBe(value);
    }
  });
  it("still localizes known document aliases and missing names", () => {
    for (const locale of ["en", "ar"] as const) {
      expect(documentTypeLabel("Invoice_A4", locale)).toBe(translate(locale, "v4.experience.document.invoiceA4"));
      expect(documentTypeLabel("receipt", locale)).toBe(translate(locale, "v4.experience.document.receipt"));
      expect(documentTypeLabel(null, locale)).toBe(translate(locale, "desktop.job.document"));
    }
  });
});
