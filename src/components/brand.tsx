import React from "react";

export function YaseirGlyph({ className = "", title = "Yaseir" }: { className?: string; title?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg">
      <path d="M7 7.75 14.13 15c1.02 1.04 2.72 1.04 3.74 0L25 7.75" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 15.3v9.1" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M8.1 24.4h15.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity=".42" />
    </svg>
  );
}

/**
 * Product mark: rounded tile + optional wordmark.
 *
 * The tile uses `--brand` so the identity follows the theme; the "inverted"
 * variant is meant for already-dark surfaces (login side panels) and therefore
 * uses the ink surface tokens instead of a hard-coded white.
 */
export function BrandMark({
  size = "md",
  showWordmark = true,
  title = "Yaseir",
  subtitle = "Print Manager",
  className = "",
  variant = "default",
}: {
  size?: "sm" | "md" | "lg";
  showWordmark?: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
  variant?: "default" | "inverted" | "compact";
}) {
  const tile = size === "lg" ? "h-10 w-10 rounded-md" : size === "sm" ? "h-[30px] w-[30px] rounded-sm" : "h-8 w-8 rounded-sm";
  const glyph = size === "lg" ? "h-5 w-5" : size === "sm" ? "h-4 w-4" : "h-4 w-4";
  const tileStyle =
    variant === "inverted"
      ? "bg-ink text-brand-contrast ring-1 ring-inset ring-white/10"
      : variant === "compact"
        ? "bg-surface-3 text-ink"
        : "bg-brand text-brand-contrast ring-1 ring-inset ring-white/15";

  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <span aria-hidden className={`flex shrink-0 items-center justify-center ${tile} ${tileStyle}`}>
        <YaseirGlyph className={glyph} title="" />
      </span>
      {showWordmark && (
        <span className="min-w-0 leading-tight">
          <span className={`block truncate text-md font-[600] tracking-[-0.025em] ${variant === "inverted" ? "text-brand-contrast" : "text-ink"}`}>
            {title}
          </span>
          {subtitle && variant !== "compact" && (
            <span className={`mt-0.5 block truncate text-2xs font-[520] tracking-[-0.005em] ${variant === "inverted" ? "text-brand-contrast/70" : "text-ink-3"}`}>
              {subtitle}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function BrandMarkIcon({
  size = "md",
  className = "",
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const tile = size === "lg" ? "h-10 w-10 rounded-md" : size === "sm" ? "h-[30px] w-[30px] rounded-sm" : "h-8 w-8 rounded-sm";
  const glyph = size === "lg" ? "h-5 w-5" : size === "sm" ? "h-4 w-4" : "h-4 w-4";
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center bg-brand text-brand-contrast ring-1 ring-inset ring-white/15 ${tile} ${className}`}>
      <YaseirGlyph className={glyph} title="" />
    </span>
  );
}
