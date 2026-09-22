import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const navbar = readFileSync("src/components/TopNavbar.tsx", "utf8");
const consoleClient = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");

describe("theme-aware navigation and console status", () => {
  it("uses shared theme tokens for navigation text and icons", () => {
    expect(navbar).toContain("text-ink-2 hover:bg-surface-2 hover:text-ink");
    expect(navbar).toContain("text-ink-3");
    expect(navbar).toContain("text-brand");
    expect(navbar).not.toContain("var(--platform-bg)");
    expect(navbar).not.toContain("var(--platform-text)");
    expect(navbar).not.toContain("text-white");
  });

  it("does not use a fixed black console Live badge", () => {
    expect(consoleClient).toContain("border-ok-edge bg-ok-bg text-ok");
    expect(consoleClient).toContain("bg-ok-solid");
    expect(consoleClient).not.toContain("border-ink bg-ink text-white");
  });
});
