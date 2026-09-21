"use client";

import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { BrandMark } from "./brand";
import { isNavItemActive } from "../lib/nav";

export type TopNavItem = {
  href: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
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
 * Shared compact horizontal top navigation.
 *
 * Replaces the previous left sidebar: global navigation stays available on
 * every authenticated page, while page content reclaims the full width.
 * Active-state detection is computed from `usePathname()` — nothing is
 * hardcoded, and nested routes highlight their parent section.
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

  return (
    <header
      className={`sticky top-0 z-40 border-b ${
        isPlatform
          ? "border-white/[0.06] bg-[#0c0e1a]/90 text-slate-100"
          : "border-edge bg-surface/90 text-ink backdrop-blur-md"
      }`}
    >
      <div className="flex h-14 w-full items-center gap-3 px-3 sm:px-5">
        <Link
          href={brandHref}
          className="flex shrink-0 items-center gap-2.5 rounded-[9px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
          aria-label={brandTitle}
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

        <nav
          aria-label="Main"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="flex items-center gap-1 whitespace-nowrap">
            {items.map((item) => {
              const active = isNavItemActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex h-9 items-center gap-2 rounded-[9px] px-3 text-[13px] font-medium transition-colors ${
                    isPlatform
                      ? active
                        ? "bg-white/[0.10] text-white"
                        : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
                      : active
                        ? "bg-brand-subtle text-brand-subtle-text font-semibold"
                        : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  {Icon && (
                    <Icon
                      className={`h-4 w-4 shrink-0 ${
                        isPlatform
                          ? active
                            ? "text-white"
                            : "text-slate-500"
                          : active
                            ? "text-brand"
                            : "text-ink-3"
                      }`}
                    />
                  )}
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>

        <button
          onClick={onLogout}
          disabled={loggingOut}
          className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-[9px] px-3 text-[13px] font-medium transition-colors disabled:opacity-50 ${
            isPlatform
              ? "border border-white/[0.08] text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
              : "border border-edge text-ink-3 hover:bg-surface-2 hover:text-ink"
          }`}
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden md:inline">
            {loggingOut ? "Signing out…" : "Sign out"}
          </span>
        </button>
      </div>
    </header>
  );
}
