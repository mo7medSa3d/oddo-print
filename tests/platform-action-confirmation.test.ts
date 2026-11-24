import { describe, expect, it } from "vitest";
import { isPlatformActionConfirmed, platformActionReason } from "../src/lib/platform-action-confirmation";

describe("Platform Owner action confirmation", () => {
  it("accepts an explicit affirmative action without asking for database IDs", () => {
    expect(isPlatformActionConfirmed({ confirmed: true }, "device-1")).toBe(true);
    expect(isPlatformActionConfirmed({}, "device-1")).toBe(false);
  });
  it("rejects a mismatched legacy confirmId even with the new flag", () => {
    expect(isPlatformActionConfirmed({ confirmed: true, confirmId: "wrong" }, "device-1")).toBe(false);
    expect(isPlatformActionConfirmed({ confirmId: "device-1" }, "device-1")).toBe(true);
  });
  it("always records a reason without arbitrary minimum typing requirements", () => {
    expect(platformActionReason(" ", "printer removal")).toContain("printer removal");
    expect(platformActionReason("Customer requested closure", "workspace deletion")).toBe("Customer requested closure");
  });
});
