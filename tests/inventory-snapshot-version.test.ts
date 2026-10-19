import { describe, expect, it } from "vitest";
import { inventoryVersionAllowsPage, parseInventorySnapshotVersion } from "../src/lib/inventory-snapshot";

describe("durable inventory snapshot version", () => {
  it("keeps adjacent int64 versions distinct beyond JavaScript number precision", () => {
    expect(parseInventorySnapshotVersion("1791392400000000001")).toBe("1791392400000000001");
    expect(inventoryVersionAllowsPage("1791392400000000001", "1791392400000000000", 1)).toBe(true);
    expect(inventoryVersionAllowsPage("1791392400000000000", "1791392400000000001", 1)).toBe(false);
  });

  it.each([undefined, null, 1, 9007199254740992, "0", "-1", "+1", "01", "1.5", "1e3", " 1", "9223372036854775808"])("rejects noncanonical or unsafe wire version %s", (raw) => {
    expect(parseInventorySnapshotVersion(raw)).toBeNull();
  });

  it("rejects completed-snapshot replay, old page 1 and foreign continuation versions", () => {
    expect(inventoryVersionAllowsPage("42", "42", 1)).toBe(false);
    expect(inventoryVersionAllowsPage("41", "42", 1)).toBe(false);
    expect(inventoryVersionAllowsPage("43", "42", 1)).toBe(true);
    expect(inventoryVersionAllowsPage("42", "42", 2)).toBe(true);
    expect(inventoryVersionAllowsPage("41", "42", 2)).toBe(false);
    expect(inventoryVersionAllowsPage("43", "42", 2)).toBe(false);
  });

  it("permits additive legacy observations before upgrade, then prevents downgrade", () => {
    expect(inventoryVersionAllowsPage(null, "0", 1)).toBe(true);
    expect(inventoryVersionAllowsPage(null, "42", 1)).toBe(false);
    expect(inventoryVersionAllowsPage("43", "corrupt", 1)).toBe(false);
  });
});
