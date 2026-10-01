"use client";

import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { LogOut, Menu, X } from "lucide-react";
import { BrandMark } from "./brand";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "./ui";
import { isNavItemActive } from "../lib/nav";

export type TopNavItem = {
  href: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  section?: string;
};

type TopNavbarProps = {
  items: TopNavItem[];
  brandHref: string;
  brandTitle: string;
  brandSubtitle?: string;
  onLogout: () => void;
  loggingOut?: boolean;
  variant?: "console" | "platform";
  brandIcon?: ReactNode;
};

/**
 * Horizontal application bar.
 *
 * The console uses the sidebar shell; this bar remains the chrome for the
 * Platform control plane and any embedded/legacy surface. Items stay grouped
 * by section, the active route is announced with aria-current, and the mobile
 * menu is a real sheet with Escape + backdrop dismissal.
 */
export function TopNavbar({
  items,
  brandHref,
  brandTitle,
  brandSubtitle,
  onLogout,
  loggingOut = false,
  variant = "console",
  brandIcon,
}: TopNavbarProps) {
  const pathname = usePathname();
  const isPlatform = variant === "platform";
  const [menuOpen, setMenuOpen] = useState(false);
  const [renderedPath, setRenderedPath] = useState(pathname);
  const panelId = useId();

  // Route changes close the mobile sheet. Adjusting state during render (rather
  // than in an effect) avoids a second paint with the stale open menu.
  if (renderedPath !== pathname) {
    setRenderedPath(pathname);
    if (menuOpen) setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-edge/80 bg-surface/95 text-ink backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-2 px-3 sm:px-5 lg:gap-4 lg:px-8">
        <Link
          href={brandHref}
          className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
          aria-label={brandTitle}
          onClick={() => setMenuOpen(false)}
        >
          {brandIcon ?? (
            <BrandMark
              size="sm"
              title={brandTitle}
              subtitle={brandSubtitle}
              showWordmark
              variant="default"
            />
          )}
        </Link>

        {isPlatform && (
          <span className="hidden shrink-0 items-center gap-1.5 rounded-sm border border-edge bg-surface-2 px-2 py-0.5 text-2xs font-[600] text-ink-3 sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--platform-accent)" }} aria-hidden />
            Control plane
          </span>
        )}

        <button
          type="button"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          aria-controls={panelId}
          onClick={() => setMenuOpen((value) => !value)}
          className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-edge bg-surface text-ink-2 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:hidden"
        >
          {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>

        <nav
          id={panelId}
          aria-label="Main"
          className={[
            menuOpen ? "flex" : "hidden",
            "pg-scale-in absolute left-3 right-3 top-[60px] z-50 flex-col gap-1 rounded-xl border border-edge-strong bg-surface p-2 shadow-xl",
            "lg:static lg:flex lg:min-w-0 lg:flex-1 lg:flex-row lg:items-center lg:gap-1 lg:overflow-x-auto lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none",
          ].join(" ")}
        >
          {items.map((item, index) => {
            const active = isNavItemActive(pathname, item.href);
            const Icon = item.icon;
            const showSection = item.section && item.section !== items[index - 1]?.section;

            return (
              <div key={item.href} className="flex items-center gap-1">
                {showSection && (
                  <span className="hidden px-2 text-2xs font-[600] uppercase tracking-[0.1em] text-ink-4 xl:inline">
                    {item.section}
                  </span>
                )}

                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                  className={[
                    "inline-flex h-9 shrink-0 items-center gap-2 rounded-sm px-2.5 text-sm font-[550] transition-colors duration-[140ms] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35",
                    active
                      ? "bg-brand-subtle text-brand-subtle-text"
                      : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                  ].join(" ")}
                >
                  {Icon && (
                    <Icon
                      className={active ? "h-4 w-4 shrink-0 text-brand" : "h-4 w-4 shrink-0 text-ink-3"}
                    />
                  )}
                  <span>{item.label}</span>
                </Link>
              </div>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1 lg:ml-0">
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={onLogout}
            disabled={loggingOut}
            icon={<LogOut className="h-4 w-4" />}
            className="text-ink-2"
            aria-label="Sign out"
            title="Sign out"
          >
            <span className="hidden xl:inline">{loggingOut ? "Signing out…" : "Sign out"}</span>
          </Button>
        </div>
      </div>

      {menuOpen && (
        <button
          type="button"
          aria-label="Close navigation menu"
          className="fixed inset-0 z-30 bg-[var(--overlay-soft)] lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}
    </header>
  );
}
