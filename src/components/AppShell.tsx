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
  CreditCard,
  Users,
  Settings as SettingsIcon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Sun,
  X,
} from "lucide-react";
import { LanguageSwitcher } from "./LanguageSwitcher";
import type { TopNavItem } from "./TopNavbar";
import { MobileAppBar } from "./MobileAppBar";
import { Avatar, Button, Callout, Menu, PageSkeleton, type MenuItemSpec } from "./ui";
import { CommandPalette, type CommandItem } from "./CommandPalette";
import { ThemeToggle, toggleTheme } from "./ThemeToggle";
import { ensureCustomerSession } from "../lib/session-config";
import { broadcastSessionSync, subscribeSessionSync, type SessionSyncEventType } from "../lib/session-sync";
import { findActiveNavItem, isNavItemActive } from "../lib/nav";
import { BrandMark } from "./brand";
import { NavIconFrame, ShellSearchButton } from "./visual-system";
import { useI18n } from "../i18n/react";
import type { Translator } from "../i18n/translate";
import { WorkspaceSecurityNotice } from "./WorkspaceSecurity";

type ConsoleNavItem = TopNavItem & {
  /** Mirrors server-side owner-only routes (server auth remains the enforcement boundary). */
  ownerOnly?: boolean;
};

// SaaS sidebar for the License & Subscription Control Plane:
// every primary workspace destination lives in the single sidebar rail.
// Sidebar visibility mirrors server-side authorization and is never itself
// an authorization boundary.
const NAV_ITEMS: ConsoleNavItem[] = [
  {
    href: "/dashboard",
    labelKey: "v4.experience.home",
    icon: LayoutDashboard,
    sectionKey: "nav.section.operations",
    keywords: "console dashboard overview home",
  },
  {
    href: "/api-keys",
    labelKey: "v4.experience.connection",
    icon: KeyRound,
    sectionKey: "nav.section.integration",
    keywords: "odoo integration linking license api keys credentials",
  },
  {
    href: "/team",
    labelKey: "v4.experience.team",
    icon: Users,
    sectionKey: "nav.section.workspace",
    keywords: "team members invitations roles access",
  },
  {
    href: "/billing",
    labelKey: "v4.experience.subscription",
    icon: CreditCard,
    sectionKey: "nav.section.workspace",
    ownerOnly: true,
    keywords: "subscription billing plan usage invoice payment",
  },
  {
    href: "/settings",
    labelKey: "nav.settings",
    icon: SettingsIcon,
    sectionKey: "nav.section.administration",
    keywords: "settings preferences profile security appearance theme language workspace",
  },
];

type WorkspaceInfo = {
  name?: string;
  email?: string;
  role?: string;
  plan?: string;
};

const COLLAPSE_KEY = "yaseir:console-nav";
/** Cross-tab sign-out interstitial: long enough to read, then auto-redirect. */
const REMOTE_SIGNOUT_REDIRECT_MS = 5000;

function getVisibleNavItems(role: string | undefined, pathname: string): ConsoleNavItem[] {
  return NAV_ITEMS.filter(
    (item) =>
      !item.ownerOnly ||
      role === "owner" ||
      (role === undefined && isNavItemActive(pathname, item.href)),
  );
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
  items,
  pathname,
  collapsed = false,
  onNavigate,
}: {
  items: readonly ConsoleNavItem[];
  pathname: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const groups = items.reduce<Array<{ section: string; items: ConsoleNavItem[] }>>((acc, item) => {
    const section = navSection(item, t);
    const last = acc[acc.length - 1];
    if (last && last.section === section) last.items.push(item);
    else acc.push({ section, items: [item] });
    return acc;
  }, []);

  return (
    <nav aria-label={t("nav.consoleNavigation")} className="flex flex-col gap-5 px-3">
      {groups.map((group) => (
        <div key={group.section} className="space-y-1">
          {!collapsed && (
            <div className="tg-sidebar-label px-2.5 pb-1 text-[11px] font-medium tracking-wide text-ink-4">
              {group.section}
            </div>
          )}
          <ul className="flex flex-col gap-1">
            {group.items.map((item) => {
              const active = isNavItemActive(pathname, item.href);
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
                    className={`sidebar-item tg-nav-item rounded-xl transition-all duration-150 ${
                      active ? "sidebar-item-active" : ""
                    } ${collapsed ? "justify-center px-0" : "px-2.5 py-2"}`}
                  >
                    {Icon && (
                      <NavIconFrame active={active}>
                        <Icon className="h-[18px] w-[18px]" />
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
    {
      key: "theme",
      label: t("nav.toggleTheme"),
      icon: (
        <>
          <Moon className="h-4 w-4 dark:hidden" />
          <Sun className="hidden h-4 w-4 dark:block" />
        </>
      ),
      separatorBefore: Boolean(workspace.email),
      onSelect: () => toggleTheme(),
    },
    {
      key: "logout",
      label: loggingOut ? t("nav.signingOut") : t("nav.signOut"),
      icon: <LogOut className="h-4 w-4 rtl:-scale-x-100" />,
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
          className={`flex w-full items-center gap-2.5 rounded-xl border border-transparent p-1.5 transition-colors duration-150 hover:border-edge/70 hover:bg-surface-2/80 ${
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
    const controller = new AbortController();
    fetchWithTimeout("/api/settings", { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          if (!cancelled && (response.status === 401 || response.status === 403)) {
            setWorkspace((current) => ({ ...current, name: undefined, email: undefined, role: undefined }));
          }
          return null;
        }
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
    fetchWithTimeout("/api/billing/status?includePlanName=1", { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          if (!cancelled && (response.status === 401 || response.status === 403)) {
            setWorkspace((current) => ({ ...current, plan: undefined }));
          }
          return null;
        }
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
      controller.abort();
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

  const navItems = getVisibleNavItems(workspace.role, pathname);
  const activeItem = findActiveNavItem(navItems, pathname) ?? findActiveNavItem(NAV_ITEMS, pathname) ?? navItems[0] ?? NAV_ITEMS[0];

  const commands: CommandItem[] = [
    ...navItems.map((item) => ({
      id: `nav-${item.href}`,
      label: navLabel(item, t),
      group: navSection(item, t),
      href: item.href,
      // English keywords stay searchable in both languages: an operator who
      // types "billing" or "team" should still find the screen in Arabic.
      keywords: `${item.href} ${item.keywords ?? ""}`,
    })),
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
        <div className={`flex min-h-18 shrink-0 items-center gap-2 border-b border-edge-subtle/80 py-3.5 ${collapsed ? "justify-center px-2" : "px-4"}`}>
          <Link
            href="/dashboard"
            aria-label={collapsed ? t("nav.home") : undefined}
            title={t("nav.home")}
            className="flex min-w-0 items-center rounded-lg focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[3px]"
          >
            <ConsoleBrand brandSubtitle={t("brand.tagline")} showWordmark={!collapsed} />
          </Link>
          {!collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={t("nav.collapseNavigation")}
              title={t("nav.collapseNavigation")}
              className="ms-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-4 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[3px]"
            >
              <PanelLeftClose className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-3">
          <ConsoleNav items={navItems} pathname={pathname} collapsed={collapsed} />
        </div>

        <div className="shrink-0 border-t border-edge-subtle/80 p-3">
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
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-ink-4 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[3px]"
              >
                <PanelLeftOpen className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2 px-0.5">
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
          title={navLabel(activeItem, t)}
          section={navSection(activeItem, t)}
          navigationId="gateway-mobile-nav"
          navigationOpen={mobileOpen}
          onOpenNavigation={() => setMobileOpen(true)}
          onSearch={() => setPaletteOpen(true)}
        />
        <main className="page-transition min-w-0 max-w-full"><WorkspaceSecurityNotice />{children}</main>
      </div>

      {/* Radix manages Escape, focus trapping and return-to-trigger. */}
      <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="pg-fade-in fixed inset-0 z-[80] bg-black/40 backdrop-blur-[2px] lg:hidden" />
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
            <div className="flex min-h-18 shrink-0 items-center justify-between gap-2 border-b border-edge-subtle/80 px-3.5 py-3.5">
              <ConsoleBrand brandSubtitle={t("brand.tagline")} />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label={t("nav.closeNavigation")}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[3px]"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-3">
              <ConsoleNav items={navItems} pathname={pathname} onNavigate={() => setMobileOpen(false)} />
            </div>
            <div className="shrink-0 space-y-2 border-t border-edge-subtle/80 p-3">
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
                className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-[550] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <LogOut className="h-4 w-4 text-ink-3 rtl:-scale-x-100" aria-hidden />
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
  // Set once when another tab reports a local logout/revocation. The ref
  // suppresses this tab's own session check (which would otherwise race the
  // interstitial with an immediate redirect); the state renders the message
  // and drives the delayed redirect below. Never re-broadcast from here.
  const [remoteSignOut, setRemoteSignOut] = useState<{ type: SessionSyncEventType; next: string } | null>(null);
  const remoteSignOutRef = useRef(false);

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
      if (checking || cancelled || remoteSignOutRef.current) return;
      checking = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        const session = await ensureCustomerSession();
        if (cancelled) return;
        if (!session.authenticated) { setAuthenticated(false); router.replace(`/login?next=${encodeURIComponent(pathname)}`); return; }
        setAuthenticated(true);
        // Tell sibling tabs the family is alive again so a stale expired
        // callout there can clear. Receivers never refresh on this event.
        broadcastSessionSync("session-renewed", "workspace");
        timer = setTimeout(() => { void check(); }, Math.max(1000, Math.min(13 * 60 * 1000, session.expiresAt - Date.now() - 60000)));
      } catch {
        if (!cancelled) timer = setTimeout(() => { void check(); }, 30000);
      } finally { checking = false; }
    };
    const visible = () => { if (document.visibilityState === "visible") { if (timer !== undefined) clearTimeout(timer); void check(); } };
    // Focus revalidation mirrors visibility: a window refocus that does not
    // change visibility (OS/app switching, embed hosts) must still
    // revalidate instead of waiting for the next timer tick.
    const onFocus = () => { if (timer !== undefined) clearTimeout(timer); void check(); };
    void check();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", onFocus); };
  }, [pathname, isPlatformScreen, isAuthScreen, isPublicScreen, router]);

  // Cross-tab session sync (workspace scope only). Public, auth, and
  // platform screens never bounce to login from a workspace event, and the
  // platform layout owns platform-kind events. This handler only ever
  // consumes; it never broadcasts, so no echo loop is possible.
  useEffect(() => {
    if (isPlatformScreen || isAuthScreen || isPublicScreen) return;
    return subscribeSessionSync("workspace", (event) => {
      if (event.type === "session-renewed") return;
      if (remoteSignOutRef.current) return;
      remoteSignOutRef.current = true;
      setAuthenticated(false);
      setRemoteSignOut({ type: event.type, next: pathname });
    });
  }, [pathname, isPlatformScreen, isAuthScreen, isPublicScreen]);

  // The interstitial above stays readable, then this tab follows the
  // signing-out tab to login. The link in the message goes immediately.
  useEffect(() => {
    if (!remoteSignOut) return;
    const timer = setTimeout(() => {
      router.replace(`/login?next=${encodeURIComponent(remoteSignOut.next)}`);
    }, REMOTE_SIGNOUT_REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [remoteSignOut, router]);

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
      // Successful local logout only: sibling tabs follow to login instead
      // of discovering a dead family on their next check. A failed logout
      // broadcasts nothing — the session may still be active.
      broadcastSessionSync("session-logged-out", "workspace");
      router.replace("/");
      router.refresh();
    } finally {
      logoutFlight.current = false;
      setLoggingOut(false);
    }
  }

  // Platform control plane keeps its own layout (src/app/platform/layout.tsx).
  if (isPlatformScreen) {
    return <div className="tg-shell-root min-h-screen min-w-0 max-w-full bg-app text-ink">{children}</div>;
  }

  // Auth screens render their own centered card — no shell chrome.
  if (isAuthScreen) {
    return <div className="min-h-screen bg-app">{children}</div>;
  }

  // Marketing home / pricing must never inherit authenticated console chrome.
  // This check intentionally precedes the authenticated branch because auth state
  // can remain true for one client render while sign-out navigates to "/".
  if (isPublicScreen) {
    return <div className="tg-shell-root min-h-screen min-w-0 max-w-full bg-app text-ink">{children}</div>;
  }

  // Another tab signed this session out (or it was revoked there). Say so
  // plainly, offer the immediate way back, and follow to login shortly.
  if (remoteSignOut) {
    return (
      <main className="tg-shell-root min-h-screen min-w-0 max-w-full bg-app p-5 text-ink">
        <div className="mx-auto max-w-lg pt-10">
          <Callout tone="warn" title={t(remoteSignOut.type === "session-revoked" ? "workspaceSecurity.sessionExpiredTitle" : "nav.signOut")}
            action={<Link href={`/login?next=${encodeURIComponent(remoteSignOut.next)}`} prefetch={false} className="font-semibold underline underline-offset-4">{t("workspaceSecurity.signIn")}</Link>}>
            {t(remoteSignOut.type === "session-logged-out" ? "workspaceSecurity.signedOutElsewhere" : "errors.sessionExpired")}
          </Callout>
        </div>
      </main>
    );
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

  // The protected page must not flash unauthenticated data or its initial
  // empty state before the session check has settled.
  return <main className="tg-shell-root min-h-screen min-w-0 max-w-full bg-app p-5" aria-busy="true"><PageSkeleton /></main>;
}

