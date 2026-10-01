import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Gateway TopNavbar responsive contract", () => {
  it("keeps the primary navigation visible at desktop breakpoints", () => {
    const source = readFileSync(join(process.cwd(), "src/components/TopNavbar.tsx"), "utf8");
    const navStart = source.indexOf("<nav");
    const navEnd = source.indexOf(">", navStart);
    const navOpenTag = navStart >= 0 && navEnd >= 0 ? source.slice(navStart, navEnd + 1) : "";

    expect(navOpenTag).toContain('aria-label="Main"');

    expect(navOpenTag).toContain("lg:flex");
    expect(navOpenTag).not.toContain("lg:hidden");
    expect(source).toContain('items.map((item, index) =>');
    expect(source).toContain('aria-current={active ? "page" : undefined}');
  });
});
