import React from "react";
import { Printer } from "lucide-react";

/* ============================================================
   YASSER — Premium Brand Lockup 2026
   Enterprise print operations — precise, trustworthy.
   Server-safe (no hooks) — shared across Gateway, Admin, Desktop.
   ============================================================ */

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
  const tile =
    size === "lg"
      ? "h-11 w-11 rounded-xl"
      : size === "sm"
        ? "h-8 w-8 rounded-lg"
        : "h-9 w-9 rounded-[10px]";
  const glyph = size === "lg" ? "h-[22px] w-[22px]" : size === "sm" ? "h-4 w-4" : "h-[18px] w-[18px]";

  const tileStyle =
    variant === "inverted"
      ? "bg-white text-slate-900 shadow-sm ring-1 ring-white/20"
      : variant === "compact"
        ? "bg-slate-900 text-white"
        : "bg-brand text-brand-contrast shadow-[0_1px_2px_rgba(37,99,235,0.18)] ring-1 ring-inset ring-white/15";

  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <span
        aria-hidden
        className={`flex flex-shrink-0 items-center justify-center ${tile} ${tileStyle}`}
      >
        <Printer className={glyph} strokeWidth={2.2} />
      </span>
      {showWordmark && (
        <span className="min-w-0 leading-[1.1]">
          <span
            className={`block truncate font-semibold tracking-[-0.015em] ${
              variant === "inverted" ? "text-white text-[14px]" : "text-ink text-[14.5px]"
            }`}
          >
            {title}
          </span>
          {subtitle && variant !== "compact" && (
            <span
              className={`block truncate text-[11px] font-medium tracking-wide ${
                variant === "inverted" ? "text-slate-400" : "text-ink-3"
              }`}
            >
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
  const tile =
    size === "lg"
      ? "h-11 w-11 rounded-xl"
      : size === "sm"
        ? "h-8 w-8 rounded-lg"
        : "h-9 w-9 rounded-[10px]";
  const glyph = size === "lg" ? "h-[22px] w-[22px]" : size === "sm" ? "h-4 w-4" : "h-[18px] w-[18px]";
  return (
    <span
      aria-hidden
      className={`flex flex-shrink-0 items-center justify-center bg-brand text-brand-contrast shadow-[0_1px_2px_rgba(37,99,235,0.18)] ring-1 ring-inset ring-white/15 ${tile} ${className}`}
    >
      <Printer className={glyph} strokeWidth={2.2} />
    </span>
  );
}
