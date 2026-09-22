"use client";

import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { LogOut, Menu, X } from "lucide-react";
import { BrandMark } from "./brand";
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
      className={isPlatform
        ? "sticky top-0 z-40 border-b border-white/[0.06] bg-[var(--platform-bg)]/92 text-slate-100 backdrop-blur-xl"
        : "sticky top-0 z-40 border-b border-edge/80 bg-surface/88 text-ink backdrop-blur-xl"}
    >
      <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-3 px-4 sm:px-7 lg:px-8">
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
              variant={isPlatform ? "inverted" : "default"}
            />
          )}
        </Link>

        <button
          type="button"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
          className={isPlatform
            ? "ml-auto inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-white/[0.08] text-slate-300 transition hover:bg-white/[0.06] sm:hidden"
            : "ml-auto inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-transparent text-ink-2 transition hover:bg-surface-2 hover:text-ink sm:hidden"}
        >
          {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>

        <nav
          aria-label="Main"
          className={[
            menuOpen ? "flex" : "hidden",
            "absolute left-3 right-3 top-[60px] z-50 flex-col gap-1 rounded-[14px] border p-1.5 shadow-xl",
            "sm:static sm:flex sm:min-w-0 sm:flex-1 sm:flex-row sm:items-center sm:gap-1 sm:overflow-x-auto sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none",
            isPlatform ? "border-white/10 bg-[var(--platform-surface)]" : "border-edge bg-surface",
          ].join(" ")}
        >
          {items.map((item, index) => {
            const active = isNavItemActive(pathname, item.href);
            const Icon = item.icon;
            const showSection = item.section && item.section !== items[index - 1]?.section;
            return (
              <div key={item.href} className="flex items-center gap-1">
                {showSection && (
                  <span
                    className={isPlatform
                      ? "hidden px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600 xl:inline"
                      : "hidden px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-4 xl:inline"}
                  >
                    {item.section}
                  </span>
                )}
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                  className={[
                    "inline-flex h-9 shrink-0 items-center gap-2 rounded-[9px] px-3 text-[13px] font-medium transition-all duration-150",
                    isPlatform
                      ? active
                        ? "bg-white/[0.10] text-white shadow-sm"
                        : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-100"
                      : active
                        ? "bg-brand-subtle text-brand-subtle-text font-semibold shadow-[inset_0_0_0_1px_var(--brand-subtle-border)]"
                        : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                  ].join(" ")}
                >
                  {Icon && (
                    <Icon
                      className={isPlatform
                        ? active
                          ? "h-4 w-4 shrink-0 text-white"
                          : "h-4 w-4 shrink-0 text-slate-500"
                        : active
                          ? "h-4 w-4 shrink-0 text-brand"
                          : "h-4 w-4 shrink-0 text-ink-3"}
                    />
                  )}
                  <span>{item.label}</span>
                  {active && (
                    <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-current opacity-60 sm:hidden" aria-hidden />
                  )}
                </Link>
              </div>
            );
          })}
        </nav>

        <button
          onClick={onLogout}
          disabled={loggingOut}
          className={isPlatform
            ? "inline-flex h-9 shrink-0 items-center gap-2 rounded-[9px] border border-white/[0.08] px-3 text-[13px] font-medium text-slate-300 transition-all duration-150 hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
            : "inline-flex h-10 shrink-0 items-center gap-2 rounded-[10px] border border-edge bg-surface px-3 text-[13px] font-medium text-ink-2 shadow-xs transition-all duration-150 hover:border-edge-strong hover:bg-surface-2 hover:text-ink disabled:opacity-50"}
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden md:inline">{loggingOut ? "Signing out…" : "Sign out"}</span>
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
