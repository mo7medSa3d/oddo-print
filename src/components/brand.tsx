import React from "react";
import { Printer } from "lucide-react";

export function BrandMark({
  size = "md",
  showWordmark = true,
  title = "Yasser",
  subtitle = "Enterprise print operations",
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
  const tile = size === "lg" ? "h-11 w-11 rounded-[13px]" : size === "sm" ? "h-8 w-8 rounded-[10px]" : "h-9 w-9 rounded-[11px]";
  const glyph = size === "lg" ? "h-[22px] w-[22px]" : size === "sm" ? "h-4 w-4" : "h-[18px] w-[18px]";
  const tileStyle = variant === "inverted"
    ? "bg-white text-[#1d1d1f] shadow-sm ring-1 ring-black/10"
    : variant === "compact"
      ? "bg-surface-3 text-ink"
      : "bg-gradient-to-b from-brand-hover to-brand text-white shadow-[0_2px_10px_rgba(0,0,0,0.16)] ring-1 ring-inset ring-white/20";

  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <span aria-hidden className={`flex shrink-0 items-center justify-center ${tile} ${tileStyle}`}>
        <Printer className={glyph} strokeWidth={2.2} />
      </span>
      {showWordmark && (
        <span className="min-w-0 leading-[1.08]">
          <span className={`block truncate text-[15px] font-semibold tracking-[-0.025em] ${variant === "inverted" ? "text-white" : "text-ink"}`}>
            {title}
          </span>
          {subtitle && variant !== "compact" && (
            <span className={`block truncate text-[10.5px] font-medium tracking-[-0.01em] ${variant === "inverted" ? "text-ink-3" : "text-ink-3"}`}>
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
  const tile = size === "lg" ? "h-11 w-11 rounded-[13px]" : size === "sm" ? "h-8 w-8 rounded-[10px]" : "h-9 w-9 rounded-[11px]";
  const glyph = size === "lg" ? "h-[22px] w-[22px]" : size === "sm" ? "h-4 w-4" : "h-[18px] w-[18px]";
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center bg-gradient-to-b from-brand-hover to-brand text-white shadow-[0_2px_10px_rgba(0,0,0,0.16)] ring-1 ring-inset ring-white/20 ${tile} ${className}`}>
      <Printer className={glyph} strokeWidth={2.2} />
    </span>
  );
}
