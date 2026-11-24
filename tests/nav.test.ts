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

  // WP8: the new first-class sidebar pages are independent routes —
  // /dashboard must not swallow them, and each highlights its own page
  // and its nested routes only.
  it("highlights the new sidebar pages independently of /dashboard", () => {
    expect(isNavItemActive("/agents", "/agents")).toBe(true);
    expect(isNavItemActive("/printers", "/printers")).toBe(true);
    expect(isNavItemActive("/jobs", "/jobs")).toBe(true);
    expect(isNavItemActive("/agents/abc", "/agents")).toBe(true);
    expect(isNavItemActive("/agents", "/dashboard")).toBe(false);
    expect(isNavItemActive("/printers", "/dashboard")).toBe(false);
    expect(isNavItemActive("/jobs", "/dashboard")).toBe(false);
    expect(isNavItemActive("/dashboard", "/agents")).toBe(false);
  });
});
