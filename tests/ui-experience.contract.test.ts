import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const load = (path: string) => readFileSync(path, "utf8");

describe("public marketing and operational UI experience contracts", () => {
  it("enhances the server-rendered landing without hiding it behind animation", () => {
    const home = load("src/app/page.tsx");
    const motion = load("src/components/marketing/LandingMotion.tsx");
    expect(home).toContain("data-yw-marketing");
    expect(home).toContain('href="/signup"');
    expect(home).toContain('href="#how-it-works"');
    expect(motion).toContain('import("gsap")');
    expect(motion).toContain('import("gsap/ScrollTrigger")');
    expect(motion).toContain("gsap.context(");
    expect(motion).toContain("context.revert()");
    expect(motion).toContain("prefers-reduced-motion: reduce");
    expect(motion).not.toContain("Lenis");
  });

  it("uses the same Radix headless library for marketing and Gateway mobile navigation", () => {
    const publicMenu = load("src/components/marketing/MobileNavigation.tsx");
    const shell = load("src/components/AppShell.tsx");
    const agent = load("src/desktop/components/Sidebar.tsx");
    for (const source of [publicMenu, shell, agent]) {
      expect(source).toContain('from "@radix-ui/react-dialog"');
      expect(source).toContain("Dialog.Root");
      expect(source).toContain("Dialog.Content");
      expect(source).toContain("Dialog.Title");
      expect(source).not.toContain("useDialog(");
    }
    expect(publicMenu).toContain("Dialog.Close");
    // Long Arabic and English links need the wider marketing breakpoint:
    // the focus-managed sheet must stay available through 1279 CSS pixels.
    const home = load("src/app/page.tsx");
    expect(home).toContain("flex-nowrap items-center gap-0.5 xl:flex");
    expect(publicMenu).toContain("xl:hidden");
    expect(publicMenu).toContain("(min-width: 1280px)");
    expect(shell).toContain("onCloseAutoFocus");
    expect(agent).toContain("onCloseAutoFocus");
    expect(agent).toContain("Dialog.Overlay");
  });

  it("keeps the operational scroll native, with no mobile motion dependency", () => {
    const css = load("src/app/globals.css");
    const home = load("src/app/page.tsx");
    const desktop = load("src/desktop/pages/Overview.tsx");
    expect(home).toContain("SpotlightSurface");
    expect(css).toContain(".yw-spotlight-card:focus-within");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".yw-gateway-dashboard");
    expect(desktop).toContain("yw-agent-overview");
    expect(load("src/components/marketing/LandingMotion.tsx")).not.toContain("gsap.ticker");
  });
});
