"use client";

import { Menu as MenuIcon, Search } from "lucide-react";
import { BrandMarkIcon } from "./brand";
import { useI18n } from "../i18n/react";

type MobileAppBarProps = {
  area: "gateway" | "platform";
  title: string;
  section?: string;
  navigationId: string;
  navigationOpen: boolean;
  onOpenNavigation: () => void;
  onSearch?: () => void;
};

/** One compact, safe-area-aware mobile app bar shared by both web shells.
 * Navigation and settings remain in the accessible sidebar sheet; the top
 * row contains only the current location and the immediate next action.
 */
export function MobileAppBar({
  area,
  title,
  section,
  navigationId,
  navigationOpen,
  onOpenNavigation,
  onSearch,
}: MobileAppBarProps) {
  const { t } = useI18n();
  return (
    <header className="tg-mobile-appbar sticky top-0 z-30 min-w-0 border-b border-edge-subtle bg-surface/95 text-ink lg:hidden">
      <div className="tg-mobile-appbar-inner flex min-h-16 min-w-0 items-center gap-2 px-3 py-2">
        <button
          type="button"
          data-gateway-mobile-navigation={area === "gateway" ? true : undefined}
          data-platform-mobile-navigation={area === "platform" ? true : undefined}
          aria-label={t("nav.openNavigation")}
          aria-haspopup="dialog"
          aria-expanded={navigationOpen}
          aria-controls={navigationId}
          onClick={onOpenNavigation}
          className="tg-mobile-appbar-button inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-edge bg-surface text-ink-2 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
        >
          <MenuIcon className="h-5 w-5" aria-hidden />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <BrandMarkIcon size="sm" className="rounded-md" />
          <div className="min-w-0 flex-1 text-start leading-tight">
            <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold leading-snug text-ink-3">
              <span className="shrink-0" dir="ltr">Yaseir</span>
              {section && <span className="min-w-0 truncate opacity-80" aria-hidden>· {section}</span>}
            </div>
            <div className="truncate text-base font-bold leading-snug text-ink" title={title}>
              {title}
            </div>
          </div>
        </div>
        {onSearch && (
          <button
            type="button"
            aria-label={t("common.search")}
            title={t("common.search")}
            onClick={onSearch}
            className="tg-mobile-appbar-button inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-ink-2 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
          >
            <Search className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>
    </header>
  );
}
