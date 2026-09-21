import { describe, it, expect } from "vitest";
import { isNavItemActive } from "../src/lib/nav";

describe("isNavItemActive", () => {
  it("highlights the exact path", () => {
    expect(isNavItemActive("/dashboard", "/dashboard")).toBe(true);
  });

  it("highlights nested routes under their parent section", () => {
    expect(isNavItemActive("/dashboard/jobs/abc", "/dashboard")).toBe(true);
  });

  it("does not highlight sibling or root paths", () => {
    expect(isNavItemActive("/dashboard", "/settings")).toBe(false);
    expect(isNavItemActive("/dashboards", "/dashboard")).toBe(false);
  });

  it("does not mistake a suffix for a nested path", () => {
    expect(isNavItemActive("/team", "/teammate")).toBe(false);
  });
});
