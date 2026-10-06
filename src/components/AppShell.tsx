"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  KeyRound,
  Users,
  CreditCard,
  Settings as SettingsIcon,
  Activity,
  LogOut,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Search,
  Sun,
  X,
} from "lucide-react";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { TopNavbar, type TopNavItem } from "./TopNavbar";
import { Avatar, Menu, useDialog, type MenuItemSpec } from "./ui";
import { CommandHint, CommandPalette, type CommandItem } from "./CommandPalette";
import { ThemeToggle, toggleTheme } from "./ThemeToggle";
import { ensureCustomerSession } from "../lib/session-config";
import { BrandMark } from "./brand";
import { useI18n } from "../i18n/react";
import type { Translator } from "../i18n/translate";

import type { MessageKey } from "../i18n/messages/en";

const NAV_ITEMS: TopNavItem[] = [
  { href: "/dashboard", labelKey: "nav.console", icon: LayoutDashboard, sectionKey: "nav.section.operations", keywords: "console dashboard overview printers jobs" },
  { href: "/system-health", labelKey: "nav.systemHealth", icon: Activity, sectionKey: "nav.section.operations", keywords: "system health monitoring uptime incidents" },
  { href: "/api-keys", labelKey: "nav.odooIntegration", icon: KeyRound, sectionKey: "nav.section.integration", keywords: "odoo integration api keys credentials" },
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
          {!collapsed && <div className="label-caps px-2 pb-1.5">{group.section}</div>}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    title={collapsed ? navLabel(item, t) : undefined}
                    onClick={onNavigate}
                    className={`sidebar-item ${active ? "sidebar-item-active" : ""} ${
                      collapsed ? "justify-center px-0" : ""
                    }`}
                  >
                    {Icon && (
                      <Icon
                        className={`h-[17px] w-[17px] shrink-0 ${
                          active ? "text-brand" : "text-ink-3"
                        }`}
                        aria-hidden
                      />
                    )}
                    {!collapsed && <span className="truncate">{navLabel(item, t)}</span>}
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
              <span className="w-full truncate text-sm font-[600] text-ink">{displayName}</span>
              <span className="w-full truncate text-xs text-ink-3">
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
  const mobilePanelRef = useRef<HTMLDivElement>(null);
  useDialog(mobileOpen, () => setMobileOpen(false), mobilePanelRef);
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
    fetch("/api/settings", { credentials: "include", cache: "no-store" })
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

    fetch("/api/billing/usage", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { plan?: { name?: string } };
      })
      .then((data) => {
        if (cancelled || !data?.plan?.name) return;
        setWorkspace((current) => ({ ...current, plan: data.plan?.name }));
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
      className="min-h-screen bg-app text-ink"
      style={{ "--nav-w": collapsed ? "72px" : "256px" } as CSSProperties}
    >
      {/* Desktop rail */}
      <aside
        aria-label={t("nav.consoleNavigation")}
        className="fixed inset-y-0 start-0 z-40 hidden flex-col border-e border-edge bg-surface lg:flex"
        style={{
          width: "var(--nav-w)",
          transition: hydrated ? "width var(--dur-normal) var(--ease-out)" : undefined,
        }}
      >
        <div className={`flex h-14 shrink-0 items-center gap-2 border-b border-edge-subtle ${collapsed ? "justify-center px-2" : "px-3"}`}>
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
              className="ms-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-ink-4 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
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
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label={t("common.search")}
                title={t("nav.searchHint")}
                className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                <Search className="h-4 w-4" aria-hidden />
              </button>
              <LanguageSwitcher align="start" placement="above" compact className="w-auto" />
              <WorkspaceMenu workspace={workspace} loggingOut={loggingOut} onLogout={onLogout} compact />
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label={t("nav.expandNavigation")}
                title={t("nav.expandNavigation")}
                className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink-4 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                <PanelLeftOpen className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <CommandHint onOpen={() => setPaletteOpen(true)} />
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
        className="lg:ps-[var(--nav-w)] motion-safe:transition-[padding-inline-start] motion-safe:duration-200 motion-safe:ease-out"
      >
        {/* Mobile chrome */}
        <header className="glass-chrome sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-edge/80 px-3 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label={t("nav.openNavigation")}
            className="inline-flex h-9 w-9 items-center justify-center rounded-sm border border-edge bg-surface text-ink-2 transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
          >
            <MenuIcon className="h-4 w-4" aria-hidden />
          </button>
          <Link href="/dashboard" aria-label={t("nav.home")} className="min-w-0">
            <ConsoleBrand brandSubtitle={t("brand.tagline")} />
          </Link>
          <div className="ms-auto flex items-center gap-1">
            <LanguageSwitcher />
            <ThemeToggle />
            <Avatar name={workspace.name || workspace.email || "Yaseir"} tone="brand" size="sm" />
          </div>
        </header>

        <main className="page-transition">{children}</main>
      </div>

      {/* Mobile navigation sheet */}
      {mobileOpen && (
        <div data-dialog-root className="fixed inset-0 z-50 lg:hidden" role="presentation">
          <div
            className="pg-fade-in absolute inset-0"
            style={{ backgroundColor: "var(--overlay)" }}
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <div
            ref={mobilePanelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={t("nav.consoleNavigation")}
            className="pg-slide-in-left absolute inset-y-0 start-0 flex w-[280px] max-w-[85vw] flex-col border-e border-edge-strong bg-surface shadow-2xl"
          >
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-edge-subtle px-3">
              <ConsoleBrand brandSubtitle={t("brand.tagline")} />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label={t("nav.closeNavigation")}
                className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-3">
              <ConsoleNav pathname={pathname} onNavigate={() => setMobileOpen(false)} />
            </div>
            <div className="shrink-0 space-y-2 border-t border-edge-subtle p-3">
              <button
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                  onLogout();
                }}
                className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm font-[550] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <LogOut className="h-4 w-4 text-ink-3" aria-hidden />
                {loggingOut ? t("nav.signingOut") : t("nav.signOut")}
              </button>
            </div>
          </div>
        </div>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={commands} />
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const refresh = () => router.refresh();
    window.addEventListener("yaseir:locale-navigation", refresh);
    return () => window.removeEventListener("yaseir:locale-navigation", refresh);
  }, [router]);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

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
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include", cache: "no-store" });
    } finally {
      router.replace("/");
      router.refresh();
      setLoggingOut(false);
    }
  }

  // Platform control plane keeps its own layout (src/app/platform/layout.tsx).
  if (isPlatformScreen) {
    return <main className="min-h-screen bg-app text-ink">{children}</main>;
  }

  // Auth screens render their own centered card — no shell chrome.
  if (isAuthScreen) {
    return <main className="min-h-screen bg-app">{children}</main>;
  }

  // Marketing home / pricing must never inherit authenticated console chrome.
  // This check intentionally precedes the authenticated branch because auth state
  // can remain true for one client render while sign-out navigates to "/".
  if (isPublicScreen) {
    return <main className="min-h-screen bg-app text-ink">{children}</main>;
  }

  // Authenticated console: sidebar shell + full-width content.
  if (authenticated === true) {
    return (
      <ConsoleShell onLogout={handleLogout} loggingOut={loggingOut}>
        {children}
      </ConsoleShell>
    );
  }

  // Brief loading state while the session check resolves, render without navigation chrome.
  return <main className="min-h-screen bg-app text-ink">{children}</main>;
}

export { TopNavbar };
