
"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import type { TopNavItem } from "../TopNavbar";
import { BrandMark } from "../brand";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { ThemeToggle } from "../ThemeToggle";
import { useDialog } from "../ui";
import { NavIconFrame } from "../visual-system";
import { useI18n } from "../../i18n/react";

const COLLAPSE_KEY = "yaseir:platform-nav";

function PlatformNavigation({
  items, pathname, collapsed = false, onNavigate,
}: {
  items: TopNavItem[];
  pathname: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const groups = items.reduce<Array<{ key: string; label: string; items: TopNavItem[] }>>((all, item) => {
    const key = item.sectionKey ?? item.section ?? "workspace";
    const label = item.sectionKey ? t(item.sectionKey) : item.section ?? t("nav.section.workspace");
    const last = all[all.length - 1];
    if (last && last.key === key) last.items.push(item);
    else all.push({ key, label, items: [item] });
    return all;
  }, []);

  return (
    <nav aria-label={t("platform.brand.controlPlane")} className="flex flex-col gap-5 px-2.5">
      {groups.map((group) => (
        <div key={group.key}>
          {!collapsed && <div className="tg-sidebar-label px-3 pb-2">{group.label}</div>}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;
              const label = item.labelKey ? t(item.labelKey) : item.label ?? item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    data-active={active}
                    title={collapsed ? label : undefined}
                    onClick={onNavigate}
                    className={["sidebar-item tg-nav-item", active ? "sidebar-item-active" : "", collapsed ? "justify-center px-0" : ""].join(" ")}
                  >
                    {Icon && <NavIconFrame active={active}><Icon className="h-[17px] w-[17px]" /></NavIconFrame>}
                    {!collapsed && <span className="truncate">{label}</span>}
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

/** Presentation only. PlatformLayout retains its platform-owner session guard. */
export function PlatformSidebar({
  items, onLogout, loggingOut, children,
}: {
  items: TopNavItem[];
  onLogout: () => void;
  loggingOut: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [renderedPath, setRenderedPath] = useState(pathname);
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(mobileOpen, () => setMobileOpen(false), panelRef);

  // Keep navigation transitions from leaving the prior mobile drawer visible.
  if (renderedPath !== pathname) {
    setRenderedPath(pathname);
    if (mobileOpen) setMobileOpen(false);
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
      } catch {
        // Storage is optional in private sessions.
      }
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // Navigation must remain usable even without persistent storage.
      }
      return next;
    });
  }

  return (
    <div className="tg-shell-root tg-platform-shell min-h-screen min-w-0 max-w-full bg-app text-ink font-sans selection:bg-brand/20" style={{ "--nav-w": collapsed ? "80px" : "264px" } as CSSProperties}>
      <aside
        aria-label={t("platform.brand.controlPlane")}
        className="tg-console-rail fixed z-40 hidden flex-col border-e border-edge bg-surface lg:flex"
        style={{ width: "var(--nav-w)", transition: hydrated ? "width var(--dur-normal) var(--ease-out)" : undefined }}
      >
        <div className={["flex h-14 shrink-0 items-center gap-2 border-b border-edge-subtle", collapsed ? "justify-center px-2" : "px-4"].join(" ")}>
          <Link href="/platform/dashboard" aria-label={t("nav.home")} className="flex min-w-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
            <BrandMark size="sm" subtitle={t("platform.brand.controlPlane")} showWordmark={!collapsed} />
          </Link>
          {!collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={t("nav.collapseNavigation")}
              title={t("nav.collapseNavigation")}
              className="ms-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-ink-4 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
            >
              <PanelLeftClose className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-3">
          <PlatformNavigation items={items} pathname={pathname} collapsed={collapsed} />
        </div>
        <div className="shrink-0 space-y-2 border-t border-edge-subtle p-2.5">
          {collapsed ? (
            <div className="flex flex-col items-center gap-1.5">
              <LanguageSwitcher align="start" placement="above" compact className="w-auto" />
              <ThemeToggle />
              <button
                type="button"
                disabled={loggingOut}
                onClick={onLogout}
                aria-label={t("nav.signOut")}
                title={t("nav.signOut")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                <LogOut className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label={t("nav.expandNavigation")}
                title={t("nav.expandNavigation")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                <PanelLeftOpen className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 px-2">
                <span className="truncate text-xs font-[600] text-ink-3">{t("nav.controlPlaneBadge")}</span>
                <div className="flex items-center gap-1">
                  <LanguageSwitcher align="start" placement="above" />
                  <ThemeToggle />
                </div>
              </div>
              <button
                type="button"
                disabled={loggingOut}
                onClick={onLogout}
                className="sidebar-item tg-nav-item flex w-full items-center gap-2.5 text-start disabled:opacity-50"
              >
                <LogOut className="h-4 w-4 shrink-0" aria-hidden />
                <span>{loggingOut ? t("nav.signingOut") : t("nav.signOut")}</span>
              </button>
            </>
          )}
        </div>
      </aside>

      {/* The mobile view uses only a floating drawer trigger, never a top bar. */}
      <button
        type="button"
        data-platform-mobile-navigation
        aria-label={t("nav.openNavigation")}
        aria-expanded={mobileOpen}
        aria-controls="platform-mobile-nav"
        onClick={() => setMobileOpen(true)}
        className="fixed start-3 top-3 z-30 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-edge bg-surface text-ink-2 shadow-md transition-colors hover:border-edge-accent hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:hidden"
      >
        <MenuIcon className="h-5 w-5" aria-hidden />
      </button>
      <div className="tg-console-content min-w-0 max-w-full motion-safe:transition-[padding-inline-start] motion-safe:duration-200 motion-safe:ease-out">
        <div className="pt-14 lg:pt-0">{children}</div>
      </div>

      {mobileOpen && (
        <div data-dialog-root className="fixed inset-0 z-[80] lg:hidden" role="presentation">
          <div className="pg-fade-in absolute inset-0" style={{ backgroundColor: "var(--overlay)" }} onClick={() => setMobileOpen(false)} aria-hidden />
          <div
            ref={panelRef}
            id="platform-mobile-nav"
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={t("platform.brand.controlPlane")}
            className="tg-mobile-sheet pg-slide-in-left absolute inset-y-0 start-0 flex w-[300px] max-w-[85vw] flex-col rounded-e-2xl border-e border-edge-strong bg-surface shadow-2xl"
          >
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-edge-subtle px-3">
              <BrandMark size="sm" subtitle={t("platform.brand.controlPlane")} />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label={t("nav.closeNavigation")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-3">
              <PlatformNavigation items={items} pathname={pathname} onNavigate={() => setMobileOpen(false)} />
            </div>
            <div className="shrink-0 space-y-2 border-t border-edge-subtle p-3">
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-[600] text-ink-3">{t("nav.controlPlaneBadge")}</span>
                <div className="flex items-center gap-1">
                  <LanguageSwitcher align="start" placement="above" />
                  <ThemeToggle />
                </div>
              </div>
              <button
                type="button"
                disabled={loggingOut}
                onClick={() => { setMobileOpen(false); onLogout(); }}
                className="sidebar-item tg-nav-item flex w-full items-center gap-2.5 text-start disabled:opacity-50"
              >
                <LogOut className="h-4 w-4 shrink-0" aria-hidden />
                {loggingOut ? t("nav.signingOut") : t("nav.signOut")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
