import React from "react";

export function YasserGlyph({ className = "", title = "Yasser" }: { className?: string; title?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg">
      <path d="M7 7.75 14.13 15c1.02 1.04 2.72 1.04 3.74 0L25 7.75" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 15.3v9.1" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M8.1 24.4h15.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity=".42" />
    </svg>
  );
}
export function BrandMark({
  size = "md",
  showWordmark = true,
  title = "Yasser",
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
  const tile = size === "lg" ? "h-11 w-11 rounded-[10px]" : size === "sm" ? "h-8 w-8 rounded-[9px]" : "h-9 w-9 rounded-[9px]";
  const glyph = size === "lg" ? "h-[22px] w-[22px]" : size === "sm" ? "h-4 w-4" : "h-[18px] w-[18px]";
  const tileStyle = variant === "inverted"
    ? "bg-white text-slate-900 shadow-sm ring-1 ring-white/20"
    : variant === "compact"
      ? "bg-slate-950 text-white"
      : "bg-brand text-brand-contrast shadow-sm ring-1 ring-inset ring-white/20";

  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <span aria-hidden className={`flex shrink-0 items-center justify-center ${tile} ${tileStyle}`}>
        <YasserGlyph className={glyph} title="" />
      </span>
      {showWordmark && (
        <span className="min-w-0 leading-[1.08]">
          <span className={`block truncate text-[15px] font-semibold tracking-[-0.025em] ${variant === "inverted" ? "text-white" : "text-ink"}`}>
            {title}
          </span>
          {subtitle && variant !== "compact" && (
            <span className={`block truncate text-[10.5px] font-medium tracking-[-0.01em] ${variant === "inverted" ? "text-slate-400" : "text-ink-3"}`}>
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
  const tile = size === "lg" ? "h-11 w-11 rounded-[10px]" : size === "sm" ? "h-8 w-8 rounded-[9px]" : "h-9 w-9 rounded-[9px]";
  const glyph = size === "lg" ? "h-[22px] w-[22px]" : size === "sm" ? "h-4 w-4" : "h-[18px] w-[18px]";
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center bg-brand text-brand-contrast shadow-sm ring-1 ring-inset ring-white/15 ${tile} ${className}`}>
      <YasserGlyph className={glyph} title="" />
    </span>
  );
}
