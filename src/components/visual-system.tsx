import type { ReactNode } from "react";
import { ChevronRight, Search } from "lucide-react";

/**
 * Yaseir's original TailGrids-inspired shell primitives.
 * These deliberately keep navigation and actions owned by their host app:
 * the Gateway uses Next.js links while the Desktop uses local page state.
 * They do not import or redistribute the TailGrids component source.
 */
export function BreadcrumbTrail({
  parent,
  current,
  label,
  className = "",
}: {
  parent: string;
  current: string;
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={`tg-breadcrumb flex min-w-0 items-center gap-2 text-xs ${className}`}>
      <span className="truncate text-ink-3">{parent}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-4 rtl:-scale-x-100" aria-hidden />
      <span aria-current="page" className="max-w-[28ch] truncate font-semibold text-ink sm:max-w-[42ch]">{current}</span>
    </nav>
  );
}

export function ShellSearchButton({
  label,
  hint,
  onClick,
  compact = false,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={hint}
      className={`tg-search-trigger inline-flex min-w-0 items-center gap-2 rounded-xl border border-edge bg-surface text-ink-3 transition-[background-color,border-color,box-shadow] duration-200 hover:border-edge-accent hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 ${compact ? "h-10 w-10 justify-center" : "h-10 px-3"}`}
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden />
      {!compact && (
        <>
          <span className="min-w-0 truncate text-sm">{label}</span>
          <kbd className="ms-auto hidden shrink-0 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-2xs font-medium text-ink-3 sm:inline">{hint}</kbd>
        </>
      )}
    </button>
  );
}

export function NavIconFrame({
  children,
  active = false,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <span aria-hidden className={`tg-nav-icon inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors duration-200 ${active ? "border-edge-accent bg-surface text-brand shadow-xs" : "border-transparent bg-transparent text-ink-3"}`}>
      {children}
    </span>
  );
}
