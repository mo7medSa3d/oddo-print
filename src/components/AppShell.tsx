"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
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
import { TopNavbar, type TopNavItem } from "./TopNavbar";
import { Avatar, Menu, type MenuItemSpec } from "./ui";
import { CommandHint, CommandPalette, type CommandItem } from "./CommandPalette";
import { ThemeToggle, toggleTheme } from "./ThemeToggle";
import { BrandMark } from "./brand";

const NAV_ITEMS: TopNavItem[] = [
  { href: "/dashboard", label: "Console", icon: LayoutDashboard, section: "Operations" },
  { href: "/system-health", label: "System health", icon: Activity, section: "Operations" },
  { href: "/api-keys", label: "Odoo integration", icon: KeyRound, section: "Integration" },
  { href: "/team", label: "Team", icon: Users, section: "Administration" },
  { href: "/billing", label: "Billing", icon: CreditCard, section: "Administration" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, section: "Administration" },
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

function ConsoleNav({
  pathname,
  collapsed = false,
  onNavigate,
}: {
  pathname: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const groups = NAV_ITEMS.reduce<Array<{ section: string; items: TopNavItem[] }>>((acc, item) => {
    const section = item.section ?? "Workspace";
    const last = acc[acc.length - 1];
    if (last && last.section === section) last.items.push(item);
    else acc.push({ section, items: [item] });
    return acc;
  }, []);

  return (
    <nav aria-label="Console" className="flex flex-col gap-5 px-2.5">
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
                    title={collapsed ? item.label : undefined}
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
                    {!collapsed && <span className="truncate">{item.label}</span>}
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
  const items: MenuItemSpec[] = [
    ...(workspace.email
      ? [{ key: "identity", label: workspace.email, meta: workspace.role, disabled: true }]
      : []),
    { key: "settings", label: "Workspace settings", icon: <SettingsIcon className="h-4 w-4" />, href: "/settings" },
    { key: "billing", label: "Plan & billing", icon: <CreditCard className="h-4 w-4" />, href: "/billing", separatorBefore: true },
    {
      key: "theme",
      label: "Toggle theme",
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
      label: loggingOut ? "Signing out…" : "Sign out",
      icon: <LogOut className="h-4 w-4" />,
      tone: "danger",
      separatorBefore: true,
      onSelect: onLogout,
      disabled: loggingOut,
    },
  ];

  const displayName = workspace.name || "Workspace";

  return (
    <Menu
      label="Account and workspace"
      className="w-full"
      placement="above"
      trigger={
        <span
          className={`flex w-full items-center gap-2 rounded-md border border-transparent p-1.5 transition-colors duration-[140ms] hover:border-edge hover:bg-surface-2 ${
            compact ? "justify-center" : ""
          }`}
        >
          <Avatar name={displayName} tone="brand" />
          {!compact && (
            <span className="flex min-w-0 flex-1 flex-col items-start leading-tight">
              <span className="w-full truncate text-sm font-[600] text-ink">{displayName}</span>
              <span className="w-full truncate text-xs text-ink-3">
                {workspace.plan ?? workspace.role ?? "Signed in"}
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo>({});
  const [renderedPath, setRenderedPath] = useState(pathname);

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

  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [mobileOpen]);

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
      label: item.label,
      group: item.section ?? "Navigate",
      href: item.href,
      keywords: `${item.href} ${item.section ?? ""}`,
    })),
    { id: "action-new-agent", label: "Register a new agent", group: "Actions", href: "/dashboard#agents", keywords: "pair pairing code machine" },
    { id: "action-theme", label: "Toggle light / dark theme", group: "Actions", onSelect: () => toggleTheme() },
    { id: "action-logout", label: "Sign out", group: "Actions", onSelect: onLogout, keywords: "log out exit" },
  ];

  return (
    <div
      className="min-h-screen bg-app text-ink"
      style={{ "--nav-w": collapsed ? "72px" : "256px" } as CSSProperties}
    >
      {/* Desktop rail */}
      <aside
        aria-label="Console navigation"
        className="fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-edge bg-surface lg:flex"
        style={{
          width: "var(--nav-w)",
          transition: hydrated ? "width var(--dur-normal) var(--ease-out)" : undefined,
        }}
      >
        <div className={`flex h-14 shrink-0 items-center gap-2 border-b border-edge-subtle ${collapsed ? "justify-center px-2" : "px-3"}`}>
          <Link
            href="/dashboard"
            aria-label="Yaseir console home"
            className="flex min-w-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
          >
            <ConsoleBrand brandSubtitle="Cloud Printing Platform" showWordmark={!collapsed} />
          </Link>
          {!collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse navigation"
              title="Collapse navigation"
              className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-ink-4 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
            >
              <PanelLeftClose className="h-4 w-4" aria-hidden />
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
                aria-label="Search"
                title="Search (⌘K)"
                className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink-3 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                <Search className="h-4 w-4" aria-hidden />
              </button>
              <WorkspaceMenu workspace={workspace} loggingOut={loggingOut} onLogout={onLogout} compact />
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label="Expand navigation"
                title="Expand navigation"
                className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink-4 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                <PanelLeftOpen className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <CommandHint onOpen={() => setPaletteOpen(true)} />
              <WorkspaceMenu workspace={workspace} loggingOut={loggingOut} onLogout={onLogout} />
            </div>
          )}
        </div>
      </aside>

      {/* Content column */}
      <div
        className="lg:pl-[var(--nav-w)] motion-safe:transition-[padding-left] motion-safe:duration-[200ms] motion-safe:ease-out"
      >
        {/* Mobile chrome */}
        <header className="glass-chrome sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-edge/80 px-3 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="inline-flex h-9 w-9 items-center justify-center rounded-sm border border-edge bg-surface text-ink-2 transition-colors duration-[140ms] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
          >
            <MenuIcon className="h-4 w-4" aria-hidden />
          </button>
          <Link href="/dashboard" aria-label="Yaseir console home" className="min-w-0">
            <ConsoleBrand brandSubtitle="Cloud Printing Platform" />
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Avatar name={workspace.name || workspace.email || "Yaseir"} tone="brand" size="sm" />
          </div>
        </header>

        <main className="page-transition">{children}</main>
      </div>

      {/* Mobile navigation sheet */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="presentation">
          <div
            className="pg-fade-in absolute inset-0"
            style={{ backgroundColor: "var(--overlay)" }}
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Console navigation"
            className="pg-slide-in-left absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col border-r border-edge-strong bg-surface shadow-2xl"
          >
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-edge-subtle px-3">
              <ConsoleBrand brandSubtitle="Cloud Printing Platform" />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
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
                {loggingOut ? "Signing out…" : "Sign out"}
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
    fetch("/api/auth/me", { method: "GET", credentials: "include", cache: "no-store" })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setAuthenticated(true);
        } else {
          // The shell is a presentation boundary, never an authorization
          // boundary: the console API routes would reject these requests
          // regardless (validateManager + per-route permissions). Redirecting
          // here only stops the user from staring at a chrome-less page whose
          // contents fail with 401s. Auth/public/platform screens are never
          // captured as a return destination to prevent redirect loops.
          const dest = encodeURIComponent(pathname);
          router.replace(`/login?next=${dest}`);
        }
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      });

    return () => {
      cancelled = true;
    };
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
