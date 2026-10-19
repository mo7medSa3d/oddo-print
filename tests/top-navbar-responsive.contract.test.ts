import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Gateway and Platform sidebar navigation", () => {
  it("removes the Gateway top navbar and retains its controls inside the sidebar", () => {
    const shell = read("src/components/AppShell.tsx");
    expect(shell).toContain("tg-console-rail");
    expect(shell).toContain('aria-current={active ? "page" : undefined}');
    expect(shell).toContain('<MobileAppBar');
    expect(shell).toContain('area="gateway"');
    expect(shell).toContain('id="gateway-mobile-nav"');
    expect(shell).toContain("Dialog.Root");
    expect(shell).toContain("Dialog.Content");
    expect(shell).toContain("onCloseAutoFocus");
    expect(shell).not.toContain("useDialog(mobileOpen");
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

  it("keeps both mobile headers in flow and dismisses navigation accessibly", () => {
    const gateway = read("src/components/AppShell.tsx");
    const platform = read("src/components/platform/PlatformSidebar.tsx");
    const bar = read("src/components/MobileAppBar.tsx");
    for (const source of [gateway, platform]) {
      expect(source).toContain("<MobileAppBar");
      expect(source).toContain("setMobileOpen(false)");
      expect(source).toContain('max-w-[85vw]');
      expect(source).not.toContain("tg-mobile-nav-trigger");
      expect(source).not.toContain("pt-14 lg:pt-0");
    }
    expect(gateway).toContain("Dialog.Overlay");
    expect(gateway).toContain("Dialog.Title");
    expect(gateway).toContain('navigationId="gateway-mobile-nav"');
    expect(platform).toContain('navigationId="platform-mobile-nav"');
    expect(bar).toContain('aria-controls={navigationId}');
    expect(bar).toContain('aria-expanded={navigationOpen}');
    expect(bar).toContain('data-gateway-mobile-navigation');
    expect(bar).toContain('data-platform-mobile-navigation');
  });
});
