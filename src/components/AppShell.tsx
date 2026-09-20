"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Menu,
  X,
  Home,
  LogOut,
  KeyRound,
  Users,
  CreditCard,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Command,
} from "lucide-react";
import { BrandMark } from "./brand";

const NAV_ITEMS = [
  { href: "/", label: "Home", icon: Home, desc: "Overview & getting started" },
  { href: "/dashboard", label: "Console", icon: LayoutDashboard, desc: "Agents, printers, jobs" },
  { href: "/api-keys", label: "API Keys", icon: KeyRound, desc: "Odoo credentials" },
  { href: "/team", label: "Team", icon: Users, desc: "Members & roles" },
  { href: "/billing", label: "Billing", icon: CreditCard, desc: "Plan & usage" },
  { href: "/settings", label: "Settings", icon: Settings, desc: "Workspace identity" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [tenantName, setTenantName] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const isAuthScreen = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password", "/invite"].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
  const isPlatformScreen = pathname === "/platform" || pathname.startsWith("/platform/");
  const isPricing = pathname === "/pricing";

  useEffect(() => {
    if (isPlatformScreen || isAuthScreen) return;
    let cancelled = false;
    fetch("/api/auth/me", { method: "GET", credentials: "include", cache: "no-store" })
      .then((res) => {
        if (!cancelled) setAuthenticated(res.ok);
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      });

    // Load tenant name for workspace selector
    fetch("/api/settings", { credentials: "include", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled && d?.tenant?.name) setTenantName(d.tenant.name);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [pathname, isPlatformScreen, isAuthScreen]);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setMobileOpen(false);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include", cache: "no-store" });
    } finally {
      router.replace("/login");
      router.refresh();
      setLoggingOut(false);
    }
  }

  if (isPlatformScreen) {
    return <main className="min-h-screen bg-slate-950 text-slate-100">{children}</main>;
  }

  if (isAuthScreen) {
    return <main className="min-h-screen bg-app">{children}</main>;
  }

  // Public marketing shell for unauthenticated users on home/pricing
  if (authenticated === false && (pathname === "/" || isPricing)) {
    return (
      <div className="flex min-h-screen flex-col bg-app text-ink">
        <header className="sticky top-0 z-40 border-b border-edge bg-surface/80 backdrop-blur-xl">
          <div className="mx-auto flex h-[64px] max-w-[1280px] items-center justify-between gap-6 px-6">
            <Link href="/" className="rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20">
              <BrandMark title="Yasser" subtitle="Enterprise print operations" />
            </Link>
            <div className="flex items-center gap-2.5">
              <Link
                href="/login"
                className="inline-flex h-9 items-center justify-center rounded-[9px] border border-edge bg-surface px-3.5 text-[13px] font-semibold text-ink-2 transition hover:bg-surface-2"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="inline-flex h-9 items-center justify-center rounded-[9px] bg-brand px-3.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-brand-hover"
              >
                Start trial
              </Link>
            </div>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-edge bg-surface">
          <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-6 py-5 text-[12px] text-ink-3">
            <span>© 2026 Yasser</span>
            <span className="hidden sm:inline">Enterprise print operations — Odoo → Gateway → Agent → Printer</span>
          </div>
        </footer>
      </div>
    );
  }

  // Authenticated app shell with sidebar
  const showSidebar = authenticated === true;

  return (
    <div className="min-h-screen bg-app text-ink">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/40 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar */}
      {showSidebar && (
        <aside
          className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-edge bg-surface transition-all duration-200 ease-out ${
            collapsed ? "w-[72px]" : "w-[272px]"
          } ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}
        >
          {/* Brand */}
          <div
            className={`flex h-[64px] shrink-0 items-center gap-3 border-b border-edge px-4 ${
              collapsed ? "justify-center px-0" : ""
            }`}
          >
            <BrandMark
              size="md"
              showWordmark={!collapsed}
              title={tenantName ?? "Yasser"}
              subtitle={collapsed ? undefined : "Enterprise print ops"}
            />
            <button
              onClick={() => setMobileOpen(false)}
              className="ml-auto rounded-[8px] p-2 text-ink-3 hover:bg-surface-2 lg:hidden"
              aria-label="Close navigation"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Workspace context */}
          {!collapsed && tenantName && (
            <div className="border-b border-edge px-3 py-3">
              <div className="rounded-[10px] border border-edge bg-surface-2 px-3 py-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Workspace</div>
                <div className="mt-0.5 truncate text-[13px] font-semibold text-ink">{tenantName}</div>
              </div>
            </div>
          )}

          {/* Navigation */}
          <nav className="flex-1 overflow-y-auto px-2.5 py-4" aria-label="Main">
            {!collapsed && (
              <div className="mb-3 px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">
                Platform
              </div>
            )}
            <div className="space-y-1">
              {NAV_ITEMS.map((item) => {
                const isActive =
                  pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    aria-current={isActive ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                    className={`group relative flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[13.5px] font-[500] tracking-[-0.01em] transition-all duration-150 ${
                      collapsed ? "justify-center px-2" : ""
                    } ${
                      isActive
                        ? "bg-brand-subtle text-brand-subtle-text font-[600]"
                        : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                    }`}
                  >
                    {isActive && !collapsed && (
                      <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand" />
                    )}
                    <Icon
                      className={`h-[18px] w-[18px] shrink-0 ${isActive ? "text-brand" : "text-ink-3 group-hover:text-ink-2"}`}
                      strokeWidth={isActive ? 2.2 : 1.8}
                    />
                    {!collapsed && (
                      <span className="flex-1 truncate text-left">{item.label}</span>
                    )}
                  </Link>
                );
              })}
            </div>

            {!collapsed && (
              <div className="mt-8">
                <div className="mb-3 px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">
                  Resources
                </div>
                <div className="space-y-1">
                  <Link
                    href="/pricing"
                    className="flex items-center gap-3 rounded-[10px] px-3 py-2 text-[13px] text-ink-3 hover:bg-surface-2 hover:text-ink"
                  >
                    <CreditCard className="h-4 w-4" />
                    Plans & pricing
                  </Link>
                </div>
              </div>
            )}
          </nav>

          {/* Footer */}
          <div className="shrink-0 border-t border-edge p-2.5">
            {!collapsed ? (
              <div className="space-y-2">
                <button
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] font-medium text-ink-3 transition hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" />
                  {loggingOut ? "Signing out…" : "Sign out"}
                </button>
                <div className="flex items-center justify-between px-1">
                  <span className="text-[11px] text-ink-4">© 2026 Yasser</span>
                  <button
                    onClick={() => setCollapsed(!collapsed)}
                    className="hidden rounded-[8px] p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink lg:inline-flex"
                    aria-label="Collapse sidebar"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <button
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="flex h-9 w-9 items-center justify-center rounded-[10px] text-ink-3 hover:bg-surface-2 hover:text-ink"
                  title="Sign out"
                >
                  <LogOut className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setCollapsed(!collapsed)}
                  className="hidden h-9 w-9 items-center justify-center rounded-[10px] text-ink-3 hover:bg-surface-2 hover:text-ink lg:inline-flex"
                  aria-label="Expand sidebar"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </aside>
      )}

      {/* Main */}
      <div
        className={`flex min-h-screen flex-col transition-[padding] duration-200 ${
          showSidebar ? (collapsed ? "lg:pl-[72px]" : "lg:pl-[272px]") : ""
        }`}
      >
        {/* Top bar */}
        {showSidebar && (
          <header className="sticky top-0 z-20 flex h-[64px] items-center gap-3 border-b border-edge bg-surface/80 px-4 backdrop-blur-xl sm:px-6">
            <button
              onClick={() => setMobileOpen(true)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] border border-edge bg-surface text-ink-2 hover:bg-surface-2 lg:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="hidden items-center gap-2 text-[13px] text-ink-3 sm:flex">
                <span className="hidden h-4 w-px bg-edge sm:inline-block" />
                <span className="truncate">
                  {NAV_ITEMS.find((n) => pathname === n.href || (n.href !== "/" && pathname.startsWith(n.href)))?.desc ??
                    "Enterprise print operations"}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="hidden items-center gap-2 rounded-[10px] border border-edge bg-surface-2 px-3 py-2 text-[12px] text-ink-3 sm:flex">
                <Search className="h-3.5 w-3.5" />
                <span>Search</span>
                <span className="ml-2 inline-flex items-center gap-1 rounded-[6px] border border-edge bg-surface px-1.5 py-0.5 text-[10px] font-medium">
                  <Command className="h-3 w-3" />K
                </span>
              </div>
            </div>
          </header>
        )}

        {!showSidebar && authenticated === null && (
          <div className="flex h-[64px] items-center justify-center border-b border-edge bg-surface">
            <div className="h-2 w-2 animate-pulse rounded-full bg-brand" />
          </div>
        )}

        <main className="flex-1">{children}</main>

        {showSidebar && (
          <footer className="border-t border-edge bg-surface/50 px-6 py-4 text-[12px] text-ink-3">
            <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4">
              <span>Odoo → Gateway → Agent → Printer</span>
              <span className="hidden sm:inline">Secure • Audited • Production-grade</span>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
