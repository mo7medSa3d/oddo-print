import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Gateway and Platform sidebar navigation", () => {
  it("uses the same wide breakpoint for marketing links and the mobile sheet in RTL", () => {
    const home = read("src/app/page.tsx");
    const mobile = read("src/components/marketing/MobileNavigation.tsx");
    const styles = read("src/app/globals.css");

    // Long translated links must not crowd out sign-in, trial and theme
    // controls at small desktop/tablet widths (up to 1279 CSS pixels).
    expect(home).toContain('flex-nowrap items-center gap-0.5 xl:flex');
    expect(home).toContain('whitespace-nowrap');
    expect(home).toContain('aria-label={t("home.brandAria")}');
    expect(home).toContain('<LanguageSwitcher compact placement="below" />');
    expect(home).toContain('className="ms-auto hidden shrink-0 items-center gap-2 xl:flex"');
    expect(mobile).toContain('window.matchMedia("(min-width: 1280px)")');
    expect(mobile).toContain('focus-visible:ring-brand xl:hidden');
    expect(mobile).toContain('outline-none');
    expect(mobile).toContain('xl:hidden');
    expect(mobile).not.toContain('(min-width: 768px)');
    expect(mobile).not.toContain('md:hidden');

    // At 320px the accessible logo label stays, only the lockup hides:
    // the public header falls back to the icon-only mark (WP6-BRANDING
    // replaced the old text wordmark with the lockup image, so the old
    // "> span:last-child" wordmark rule no longer exists).
    expect(home).toContain('className="yw-public-brand-mark"');
    expect(styles).toContain('@media (max-width: 399.98px)');
    expect(styles).toContain('.yw-public-brand-mark .brand-lockup-chip');
    expect(styles).toContain('.yw-public-brand-mark .brand-mark-icon-fallback');
  });


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
