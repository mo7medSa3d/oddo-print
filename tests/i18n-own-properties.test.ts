import { describe, expect, it } from "vitest";
import { translate, translateCount } from "../src/i18n/translate";
import { lifecycleLabel } from "../src/lib/lifecycle-labels";
import type { MessageKey } from "../src/i18n/messages/en";

describe("translation prototype boundaries", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("renders unknown %s safely", key => {
    expect(translate("ar", key as MessageKey, { count: 2 })).toBe(key);
    expect(translateCount("ar", key, 2)).toBe(key);
    expect(lifecycleLabel(k => k, key)).toBe("lifecycle.active");
  });
  it("keeps real locale plural categories and interpolation", () => {
    expect(translateCount("ar", "printer.count", 2)).toBe("طابعتان");
    expect(translateCount("ar", "printer.count", 3)).toBe("3 طابعات");
    expect(translate("en", "auth.signIn.workspaceSuffix", { suffix: "123456" })).toBe("Workspace …123456");
  });
});
