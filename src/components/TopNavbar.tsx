"use client";

import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { LogOut, Menu, X } from "lucide-react";
import { BrandMark } from "./brand";
import { ThemeToggle } from "./ThemeToggle";
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

  return (
    <header
      data-platform-navbar={isPlatform ? "true" : undefined}
      className="sticky top-0 z-40 border-b border-edge/80 bg-surface/95 text-ink shadow-[0_1px_0_rgba(15,23,42,0.03)] backdrop-blur-xl backdrop-saturate-150 dark:shadow-[0_1px_0_rgba(255,255,255,0.04)]"
    >
      <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-2 px-3 sm:px-5 lg:gap-3 lg:px-8">
        <Link
          href={brandHref}
          className="shrink-0 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
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

        <button
          type="button"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
          className="ml-auto inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-edge bg-surface text-ink-2 transition hover:bg-surface-2 hover:text-ink lg:hidden"
        >
          {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>

        <nav
          aria-label="Main"
          className={[
            menuOpen ? "flex" : "hidden",
            "absolute left-3 right-3 top-[60px] z-50 flex-col gap-1 rounded-[14px] border border-edge bg-surface p-2 shadow-xl",
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
                  <span className="hidden px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-4 xl:inline">
                    {item.section}
                  </span>
                )}

                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                  className={[
                    "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-all duration-200 whitespace-nowrap",
                    active
                      ? "bg-brand-subtle text-brand-subtle-text font-semibold shadow-[inset_0_0_0_1px_var(--brand-subtle-border)]"
                      : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                  ].join(" ")}
                >
                  {Icon && (
                    <Icon
                      className={active ? "h-4 w-4 shrink-0 text-brand" : "h-4 w-4 shrink-0 text-ink-3"}
                    />
                  )}
                  <span>{item.label}</span>
                  {active && (
                    <span
                      className="ml-0.5 h-1.5 w-1.5 rounded-full bg-current opacity-60 lg:hidden"
                      aria-hidden
                    />
                  )}
                </Link>
              </div>
            );
          })}
        </nav>

        <ThemeToggle />

        <button
          onClick={onLogout}
          disabled={loggingOut}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-edge bg-surface px-3.5 text-[13px] font-medium text-ink-2 shadow-xs transition-all duration-200 hover:border-edge-strong hover:bg-surface-2 hover:text-ink disabled:opacity-50"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden xl:inline">{loggingOut ? "Signing out…" : "Sign out"}</span>
        </button>
      </div>

      {menuOpen && (
        <button
          type="button"
          aria-label="Close navigation menu"
          className="fixed inset-0 z-40 bg-black/5 sm:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}
    </header>
  );
}
