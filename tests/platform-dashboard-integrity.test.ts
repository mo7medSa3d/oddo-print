import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dashboard = readFileSync("src/app/platform/dashboard/page.tsx", "utf8");
const navbar = readFileSync("src/components/TopNavbar.tsx", "utf8");
const platformLogin = readFileSync("src/app/platform/login/page.tsx", "utf8");

describe("platform dashboard visual/data integrity", () => {
  it("does not contain hard-coded demo metrics or fabricated trend data", () => {
    expect(dashboard).not.toContain("+32.54%");
    expect(dashboard).not.toContain("49% than last month");
    expect(dashboard).not.toContain("7k");
    expect(dashboard).not.toContain("6k");
    expect(dashboard).not.toContain("5k");
    expect(dashboard).not.toContain("Total New Users");
    expect(dashboard).not.toContain("Fleet Activity Trends");
    expect(dashboard).not.toContain("Panze Studio");
    expect(dashboard).not.toContain("Standard Cloud");
    expect(dashboard).not.toContain("gradient-to-t");
  });

  it("uses shared theme tokens for the platform navigation", () => {
    expect(navbar).toContain("bg-surface/95");
    expect(navbar).toContain("border-edge/80");
    expect(navbar).toContain("text-ink");
    expect(navbar).toContain('variant="default"');
    expect(navbar).not.toContain("var(--platform-bg)");
    expect(navbar).not.toContain("var(--platform-surface)");
    expect(navbar).not.toContain("white/12");
  });

  it("uses the same Gateway theme and BrandMark on the Platform Login page", () => {
    expect(platformLogin).toContain('import { AuthShell } from "../../../components/AuthShell";');
    expect(platformLogin).toContain('import { Button, ErrorState, Field, Input } from "../../../components/ui";');
    expect(platformLogin).toContain('<AuthShell subtitle="Platform Control Plane">');
    expect(platformLogin).toContain("border-edge-strong bg-surface");
    expect(platformLogin).not.toContain("var(--platform-bg)");
    expect(platformLogin).not.toContain("var(--platform-surface)");
    expect(platformLogin).not.toContain("var(--glow)");
    expect(platformLogin).not.toContain('variant="inverted"');
  });
});
