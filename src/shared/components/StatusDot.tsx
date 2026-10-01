"use client";
import { cn } from "../../lib/utils";

import { jobTone } from "../job-vocabulary";

/**
 * Legacy status pill kept for compatibility with server-rendered lists.
 * Colours come from the shared status tokens (see src/app/globals.css) —
 * never from raw palette utilities — so every surface reads the same.
 */
export function StatusDot({ status, label }: { status: string; label?: string }) {
  const tone = jobTone(status);
  const color =
    status === "online" ? "bg-ok-solid" :
    status === "offline" || status === "error" ? "bg-bad-solid" :
    status === "busy" ? "bg-warn-solid" :
    tone === "ok" ? "bg-ok-solid" :
    tone === "bad" ? "bg-bad-solid" :
    tone === "warn" ? "bg-warn-solid" :
    tone === "info" ? "bg-info-solid" :
    "bg-ink-4";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-[550] text-ink-2">
      <span className={cn("h-2 w-2 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15", color)} aria-hidden />
      {label ?? status}
    </span>
  );
}
