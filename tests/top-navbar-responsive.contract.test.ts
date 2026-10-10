import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Gateway and Platform sidebar navigation", () => {
  it("removes the Gateway top navbar and retains its controls inside the sidebar", () => {
    const shell = read("src/components/AppShell.tsx");
    expect(shell).toContain("tg-console-rail");
    expect(shell).toContain('aria-current={active ? "page" : undefined}');
    expect(shell).toContain("data-gateway-mobile-navigation");
    expect(shell).toContain('id="gateway-mobile-nav"');
    expect(shell).toContain("useDialog(mobileOpen");
    expect(shell).toContain("ShellSearchButton");
    expect(shell).toContain("ThemeToggle");
    expect(shell).toContain('placement="above"');
    expect(shell).not.toContain("tg-console-topbar");
    expect(shell).not.toContain("<BreadcrumbTrail");
    expect(shell).not.toContain("<TopNavbar");
  });

  it("renders the authenticated Platform with a matching collapsible sidebar", () => {
    const layout = read("src/app/platform/layout.tsx");
    const sidebar = read("src/components/platform/PlatformSidebar.tsx");
    expect(layout).toContain("<PlatformSidebar items={NAV_ITEMS}");
    expect(layout).not.toContain("<TopNavbar");
    expect(layout).toContain('if (isLoginPage) return <>{children}</>');
    expect(layout).toContain("if (authenticated === null || authenticated === false)");
    expect(sidebar).toContain("tg-console-rail");
    expect(sidebar).toContain("tg-console-content");
    expect(sidebar).toContain('aria-current={active ? "page" : undefined}');
    expect(sidebar).toContain("useDialog(mobileOpen");
    expect(sidebar).toContain('aria-modal="true"');
    expect(sidebar).toContain("onNavigate");
    expect(sidebar).toContain("yaseir:platform-nav");
    expect(sidebar).toContain("LanguageSwitcher");
    expect(sidebar).toContain("ThemeToggle");
    expect(sidebar).toContain("loggingOut");
  });

  it("allows keyboard and mobile dismissal with a small trigger, not a horizontal menu", () => {
    const gateway = read("src/components/AppShell.tsx");
    const platform = read("src/components/platform/PlatformSidebar.tsx");
    for (const source of [gateway, platform]) {
      expect(source).toContain('className="fixed start-3 top-3 z-30');
      expect(source).toContain("useDialog(mobileOpen");
      expect(source).toContain("setMobileOpen(false)");
      expect(source).toContain('max-w-[85vw]');
      expect(source).toContain("pt-14 lg:pt-0");
    }
    expect(gateway).toContain('aria-controls="gateway-mobile-nav"');
    expect(platform).toContain('aria-controls="platform-mobile-nav"');
  });
});
