import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Gateway TopNavbar responsive contract", () => {
  it("keeps the primary navigation visible at desktop breakpoints", () => {
    const source = readFileSync(join(process.cwd(), "src/components/TopNavbar.tsx"), "utf8");
    const navClassBlock = source.match(/<nav\b(?=[^>]*aria-label="Main")[^>]*className=\{\[([\s\S]*?)\]\}/)?.[1] ?? "";

    expect(navClassBlock).toContain("lg:flex");
    expect(navClassBlock).not.toContain("lg:hidden");
    expect(source).toContain('items.map((item, index) =>');
    expect(source).toContain('aria-current={active ? "page" : undefined}');
  });
});
