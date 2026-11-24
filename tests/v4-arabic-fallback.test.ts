import { describe, expect, it } from "vitest";
import { catalogs, translate } from "../src/i18n/translate";
import type { MessageKey } from "../src/i18n/messages/en";

describe("Arabic customer fallback boundary", () => {
  it("never exposes the English value of a missing Arabic key", () => {
    const key = "auth.signIn.workspaceSuffix";
    const saved = catalogs.ar[key];
    try {
      delete (catalogs.ar as Partial<typeof catalogs.ar>)[key];
      expect(translate("ar", key, { suffix: "123" })).toBe("النص غير متاح");
      expect(translate("en", key, { suffix: "123" })).toBe("Workspace …123");
      catalogs.ar[key] = " ";
      expect(translate("ar", key)).toBe("النص غير متاح");
    } finally { catalogs.ar[key] = saved; }
  });
  it("does not display unknown internal diagnostic keys in Arabic", () => {
    expect(translate("ar", "SQL_BACKEND_UNKNOWN_ERROR" as MessageKey)).toBe("النص غير متاح");
  });
});
