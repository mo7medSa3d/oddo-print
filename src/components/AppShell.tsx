"use client";

import { fetchWithTimeout } from "../lib/fetch-timeout";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  KeyRound,
  Users,
  CreditCard,
  Settings as SettingsIcon,
  Activity,
  ClipboardCheck,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Sun,
  X,
} from "lucide-react";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { TopNavbar, type TopNavItem } from "./TopNavbar";
import { MobileAppBar } from "./MobileAppBar";
import { Avatar, Button, Callout, Menu, type MenuItemSpec } from "./ui";
import { CommandPalette, type CommandItem } from "./CommandPalette";
import { ThemeToggle, toggleTheme } from "./ThemeToggle";
import { ensureCustomerSession } from "../lib/session-config";
import { BrandMark } from "./brand";
import { NavIconFrame, ShellSearchButton } from "./visual-system";
import { useI18n } from "../i18n/react";
import type { Translator } from "../i18n/translate";

const NAV_ITEMS: TopNavItem[] = [
  { href: "/dashboard", labelKey: "nav.console", icon: LayoutDashboard, sectionKey: "nav.section.operations", keywords: "console dashboard overview printers jobs" },
  { href: "/system-health", labelKey: "nav.systemHealth", icon: Activity, sectionKey: "nav.section.operations", keywords: "system health monitoring uptime incidents" },
  { href: "/api-keys", labelKey: "nav.odooIntegration", icon: KeyRound, sectionKey: "nav.section.integration", keywords: "odoo integration api keys credentials" },
  { href: "/capture-tests", labelKey: "nav.captureTests", icon: ClipboardCheck, sectionKey: "nav.section.integration", keywords: "odoo e2e capture tests gateway agent received documents" },
  { href: "/team", labelKey: "nav.team", icon: Users, sectionKey: "nav.section.administration", keywords: "team members roles invitations" },
  { href: "/billing", labelKey: "nav.billing", icon: CreditCard, sectionKey: "nav.section.administration", keywords: "billing plan subscription invoices" },
  { href: "/settings", labelKey: "nav.settings", icon: SettingsIcon, sectionKey: "nav.section.administration", keywords: "settings preferences workspace" },
];

type WorkspaceInfo = {
  name?: string;
  email?: string;
  role?: string;
  plan?: string;
};

const COLLAPSE_KEY = "yaseir:console-nav";

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Product lockup for the console chrome.
 *
 * `brandSubtitle` is the PRODUCT identity and stays constant across tenants;
 * the tenant's own name is shown by WorkspaceMenu, so swapping the tenant into
 * the wordmark would both lose the product line and duplicate that identity.
 */
function ConsoleBrand({ brandSubtitle, showWordmark = true }: { brandSubtitle: string; showWordmark?: boolean }) {
  return (
    <BrandMark size="sm" title="Yaseir" subtitle={brandSubtitle} showWordmark={showWordmark} variant="default" />
  );
}

function navLabel(item: TopNavItem, t: Translator): string {
  if (item.labelKey) return t(item.labelKey);
  return item.label ?? item.href;
}

function navSection(item: TopNavItem, t: Translator): string {
  if (item.sectionKey) return t(item.sectionKey);
  return item.section ?? t("nav.section.workspace");
}

function ConsoleNav({
  pathname,
  collapsed = false,
  onNavigate,
}: {
  pathname: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const groups = NAV_ITEMS.reduce<Array<{ section: string; items: TopNavItem[] }>>((acc, item) => {
    const section = navSection(item, t);
    const last = acc[acc.length - 1];
    if (last && last.section === section) last.items.push(item);
    else acc.push({ section, items: [item] });
    return acc;
  }, []);

  return (
    <nav aria-label={t("nav.consoleNavigation")} className="flex flex-col gap-5 px-2.5">
      {groups.map((group) => (
        <div key={group.section}>
          {!collapsed && <div className="tg-sidebar-label px-3 pb-2">{group.section}</div>}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    aria-label={collapsed ? navLabel(item, t) : undefined}
                    title={collapsed ? navLabel(item, t) : undefined}
                    onClick={onNavigate}
                    data-active={active}
                    className={`sidebar-item tg-nav-item ${active ? "sidebar-item-active" : ""} ${
                      collapsed ? "justify-center px-0" : ""
                    }`}
                  >
                    {Icon && (
                      <NavIconFrame active={active}>
                        <Icon className="h-[17px] w-[17px]" />
                      </NavIconFrame>
                    )}
                    {!collapsed && <span className="min-w-0 flex-1 break-words leading-snug">{navLabel(item, t)}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function WorkspaceMenu({
  workspace,
  loggingOut,
  onLogout,
  compact = false,
}: {
  workspace: WorkspaceInfo;
  loggingOut: boolean;
  onLogout: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const items: MenuItemSpec[] = [
    ...(workspace.email
      ? [{ key: "identity", label: workspace.email, meta: workspace.role, disabled: true }]
      : []),
    { key: "settings", label: t("nav.workspaceSettings"), icon: <SettingsIcon className="h-4 w-4" />, href: "/settings" },
    { key: "billing", label: t("nav.planAndBilling"), icon: <CreditCard className="h-4 w-4" />, href: "/billing", separatorBefore: true },
    {
      key: "theme",
      label: t("nav.toggleTheme"),
      icon: (
        <>
          <Moon className="h-4 w-4 dark:hidden" />
          <Sun className="hidden h-4 w-4 dark:block" />
        </>
      ),
      onSelect: () => toggleTheme(),
    },
    {
      key: "logout",
      label: loggingOut ? t("nav.signingOut") : t("nav.signOut"),
      icon: <LogOut className="h-4 w-4" />,
      tone: "danger",
      separatorBefore: true,
      onSelect: onLogout,
      disabled: loggingOut,
    },
  ];

  const displayName = workspace.name || t("nav.workspace");

  return (
    <Menu
      label={t("nav.accountAndWorkspace")}
      className="w-full"
      placement="above"
      align="start"
      trigger={
        <span
          className={`flex w-full items-center gap-2 rounded-md border border-transparent p-1.5 transition-colors duration-150 hover:border-edge hover:bg-surface-2 ${
            compact ? "justify-center" : ""
          }`}
        >
          <Avatar name={displayName} tone="brand" />
          {!compact && (
            <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
              <span className="w-full break-words text-sm font-[600] leading-snug text-ink">{displayName}</span>
              <span className="mt-0.5 w-full break-words text-xs leading-snug text-ink-3">
                {workspace.plan ?? workspace.role ?? t("nav.signedIn")}
              </span>
            </span>
          )}
        </span>
      }
      items={items}
    />
  );
}

function ConsoleShell({
  children,
  onLogout,
  loggingOut,
}: {
  children: ReactNode;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo>({});
  const [renderedPath, setRenderedPath] = useState(pathname);
  const { t } = useI18n();

  // Navigating closes the mobile sheet; doing it during render avoids painting
  // the previous route with an open drawer.
  if (renderedPath !== pathname) {
    setRenderedPath(pathname);
    if (mobileOpen) setMobileOpen(false);
  }

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // The rail preference lives in browser storage, which is unavailable during
    // SSR. Read it on the first frame after paint: the server and client agree
    // on the expanded rail, then the stored preference applies without hydrating
    // mismatched markup or animating the initial width change.
    const frame = window.requestAnimationFrame(() => {
      try {
        setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
      } catch {
        /* storage unavailable — stay expanded */
      }
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchWithTimeout("/api/settings", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { tenant?: { name?: string }; email?: string; role?: string };
      })
      .then((data) => {
        if (cancelled || !data) return;
        setWorkspace((current) => ({
          ...current,
          name: data.tenant?.name,
          email: data.email,
          role: data.role,
        }));
      })
      .catch(() => undefined);

    // The sidebar displays a plan label, not privileged quota usage. Use the
    // optional status summary: missing subscriptions and non-billing roles get
    // a normal 200 response with no plan name instead of expected 403 noise.
    fetchWithTimeout("/api/billing/status?includePlanName=1", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { hasSubscription?: boolean; planName?: string | null };
      })
      .then((data) => {
        if (cancelled || !data) return;
        setWorkspace((current) => ({
          ...current,
          plan: data.hasSubscription && typeof data.planName === "string" ? data.planName : undefined,
        }));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);


  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const commands: CommandItem[] = [
    ...NAV_ITEMS.map((item) => ({
      id: `nav-${item.href}`,
      label: navLabel(item, t),
      group: navSection(item, t),
      href: item.href,
      // English keywords stay searchable in both languages: an operator who
      // types "billing" or "team" should still find the screen in Arabic.
      keywords: `${item.href} ${item.keywords ?? ""}`,
    })),
    { id: "action-new-agent", label: t("agent.add"), group: t("common.actions"), href: "/dashboard#agents", keywords: "pair pairing code machine agent" },
    { id: "action-theme", label: t("nav.toggleTheme"), group: t("common.actions"), onSelect: () => toggleTheme() },
    { id: "action-logout", label: t("nav.signOut"), group: t("common.actions"), onSelect: onLogout, keywords: "log out exit" },
  ];

  return (
    <div
      className="tg-shell-root min-h-screen min-w-0 max-w-full bg-app text-ink"
      style={{ "--nav-w": collapsed ? "var(--sidebar-collapsed)" : "var(--sidebar-width)" } as CSSProperties}
    >
      {/* Desktop rail */}
      <aside
        aria-label={t("nav.consoleNavigation")}
        className="tg-console-rail fixed z-40 hidden flex-col lg:flex"
        style={{
          width: "var(--nav-w)",
          transition: hydrated ? "width var(--dur-normal) var(--ease-out)" : undefined,
        }}
      >
        <div className={`flex min-h-18 shrink-0 items-center gap-2 border-b border-edge-subtle py-3 ${collapsed ? "justify-center px-2" : "px-4"}`}>
          <Link
            href="/dashboard"
            aria-label={t("nav.home")}
            className="flex min-w-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
          >
            <ConsoleBrand brandSubtitle={t("brand.tagline")} showWordmark={!collapsed} />
          </Link>
          {!collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={t("nav.collapseNavigation")}
              title={t("nav.collapseNavigation")}
              className="ms-auto inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-sm text-ink-4 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
            >
              <PanelLeftClose className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-3">
          <ConsoleNav pathname={pathname} collapsed={collapsed} />
        </div>

        <div className="shrink-0 border-t border-edge-subtle p-2.5">
          {collapsed ? (
            <div className="flex flex-col items-center gap-1.5">
              <ShellSearchButton label={t("common.search")} hint={t("nav.searchHint")} compact onClick={() => setPaletteOpen(true)} />
              <ThemeToggle />
              <LanguageSwitcher align="start" placement="above" compact className="w-auto" />
              <WorkspaceMenu workspace={workspace} loggingOut={loggingOut} onLogout={onLogout} compact />
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label={t("nav.expandNavigation")}
                title={t("nav.expandNavigation")}
                className="inline-flex h-10 w-10 items-center justify-center rounded-sm text-ink-4 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                <PanelLeftOpen className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 px-1">
                <ShellSearchButton label={t("common.search")} hint={t("nav.searchHint")} onClick={() => setPaletteOpen(true)} />
                <ThemeToggle />
              </div>
              <div className="flex items-center gap-2">
                <LanguageSwitcher align="start" placement="above" className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <WorkspaceMenu workspace={workspace} loggingOut={loggingOut} onLogout={onLogout} />
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Content column */}
      <div
        className="tg-console-content min-w-0 max-w-full motion-safe:transition-[padding-inline-start] motion-safe:duration-200 motion-safe:ease-out"
      >
        <MobileAppBar
          area="gateway"
          title={navLabel(NAV_ITEMS.find((item) => isActive(pathname, item.href)) ?? NAV_ITEMS[0], t)}
          section={t("nav.section.workspace")}
          navigationId="gateway-mobile-nav"
          navigationOpen={mobileOpen}
          onOpenNavigation={() => setMobileOpen(true)}
          onSearch={() => setPaletteOpen(true)}
        />
        <main className="page-transition min-w-0 max-w-full">{children}</main>
      </div>

      {/* Radix manages Escape, focus trapping and return-to-trigger. */}
      <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="pg-fade-in fixed inset-0 z-[80] bg-black/40 lg:hidden" />
          <Dialog.Content
            id="gateway-mobile-nav"
            data-dialog-root
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              const trigger = document.querySelector<HTMLButtonElement>('[aria-controls="gateway-mobile-nav"]');
              if (trigger) { event.preventDefault(); trigger.focus(); }
            }}
            className="tg-mobile-sheet pg-slide-in-left fixed inset-y-0 start-0 z-[81] flex w-[300px] max-w-[85vw] flex-col rounded-e-2xl border-e border-edge-strong bg-surface shadow-2xl outline-none lg:hidden"
          >
            <Dialog.Title className="sr-only">{t("nav.consoleNavigation")}</Dialog.Title>
            <div className="flex min-h-18 shrink-0 items-center justify-between gap-2 border-b border-edge-subtle px-3 py-3">
              <ConsoleBrand brandSubtitle={t("brand.tagline")} />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label={t("nav.closeNavigation")}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-3">
              <ConsoleNav pathname={pathname} onNavigate={() => setMobileOpen(false)} />
            </div>
            <div className="shrink-0 space-y-2 border-t border-edge-subtle p-3">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <ShellSearchButton label={t("common.search")} hint={t("nav.searchHint")} onClick={() => { setMobileOpen(false); setPaletteOpen(true); }} />
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
                  <LanguageSwitcher align="start" placement="above" />
                  <ThemeToggle />
                </div>
              </div>
              <button
                type="button"
                disabled={loggingOut}
                onClick={() => {
                  setMobileOpen(false);
                  onLogout();
                }}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm font-[550] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <LogOut className="h-4 w-4 text-ink-3" aria-hidden />
                {loggingOut ? t("nav.signingOut") : t("nav.signOut")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={commands} />
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  useEffect(() => {
    const refresh = () => router.refresh();
    window.addEventListener("yaseir:locale-navigation", refresh);
    return () => window.removeEventListener("yaseir:locale-navigation", refresh);
  }, [router]);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const logoutFlight = useRef(false);

  const isAuthScreen = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password", "/invite"].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
  const isPlatformScreen = pathname === "/platform" || pathname.startsWith("/platform/");
  // Public marketing/informational pages render server-side for anonymous
  // visitors (they read auth from cookies themselves) and must never be
  // bounced to /login.
  const isPublicScreen = pathname === "/" || pathname.startsWith("/pricing");

  useEffect(() => {
    if (isPlatformScreen || isAuthScreen || isPublicScreen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checking = false;
    const check = async () => {
      if (checking || cancelled) return;
      checking = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        const session = await ensureCustomerSession();
        if (cancelled) return;
        if (!session.authenticated) { setAuthenticated(false); router.replace(`/login?next=${encodeURIComponent(pathname)}`); return; }
        setAuthenticated(true);
        timer = setTimeout(() => { void check(); }, Math.max(1000, Math.min(13 * 60 * 1000, session.expiresAt - Date.now() - 60000)));
      } catch {
        if (!cancelled) timer = setTimeout(() => { void check(); }, 30000);
      } finally { checking = false; }
    };
    const visible = () => { if (document.visibilityState === "visible") { if (timer !== undefined) clearTimeout(timer); void check(); } };
    void check();
    document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [pathname, isPlatformScreen, isAuthScreen, isPublicScreen, router]);

  async function handleLogout() {
    if (logoutFlight.current) return;
    logoutFlight.current = true;
    setLoggingOut(true);
    setLogoutFailed(false);
    // Revoke the manager family through its own cookie path FIRST: the
    // mgr_refresh cookie is scoped to /api/auth/manager and the generic
    // logout below cannot see it (nor revoke the family when the access
    // cookie already expired). Manager logout also clears the manager
    // cookies; generic logout then revokes the customer family and clears
    // every remaining pair. An outage cannot prove server-side revocation.
    let failed = false;
    try {
      try {
        const response = await fetchWithTimeout("/api/auth/manager/logout", { method: "POST", credentials: "include", cache: "no-store" });
        failed = !response.ok;
      } catch { failed = true; }
      try {
        const response = await fetchWithTimeout("/api/auth/logout", { method: "POST", credentials: "include", cache: "no-store" });
        failed ||= !response.ok;
      } catch { failed = true; }
      if (failed) {
        setLogoutFailed(true);
        return;
      }
      router.replace("/");
      router.refresh();
    } finally {
      logoutFlight.current = false;
      setLoggingOut(false);
    }
  }

  // Platform control plane keeps its own layout (src/app/platform/layout.tsx).
  if (isPlatformScreen) {
    return <main className="tg-shell-root min-h-screen min-w-0 max-w-full bg-app text-ink">{children}</main>;
  }

  // Auth screens render their own centered card — no shell chrome.
  if (isAuthScreen) {
    return <main className="min-h-screen bg-app">{children}</main>;
  }

  // Marketing home / pricing must never inherit authenticated console chrome.
  // This check intentionally precedes the authenticated branch because auth state
  // can remain true for one client render while sign-out navigates to "/".
  if (isPublicScreen) {
    return <main className="tg-shell-root min-h-screen min-w-0 max-w-full bg-app text-ink">{children}</main>;
  }

  // Authenticated console: sidebar shell + full-width content.
  if (authenticated === true) {
    return (
      <ConsoleShell onLogout={handleLogout} loggingOut={loggingOut}>
        {logoutFailed && <Callout tone="bad" title={t("nav.signOut")} action={<Button variant="secondary" size="sm" onClick={() => void handleLogout()}>{t("common.retry")}</Button>}>
          {t("platform.session.logoutFailed")}
        </Callout>}
        {children}
      </ConsoleShell>
    );
  }

  // Brief loading state while the session check resolves, render without navigation chrome.
  return <main className="tg-shell-root min-h-screen min-w-0 max-w-full bg-app text-ink">{children}</main>;
}

export { TopNavbar };
