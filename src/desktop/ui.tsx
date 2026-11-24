import React from "react";
import { ChevronRight } from "lucide-react";
import { StatusDot, type Tone } from "../components/ui";
import type { Locale } from "../i18n/config";

export function VirtualBadge({ locale = "en" }: { locale?: Locale }) {
  return (
    <span className="virtual-printer-badge shrink-0" title={locale === "ar" ? "طابعة افتراضية" : "Virtual printer"}>
      {locale === "ar" ? "افتراضية" : "Virtual"}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children?: React.ReactNode; }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-3xl font-semibold leading-tight tracking-[-0.025em] text-ink sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-xl text-base leading-relaxed text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex w-full min-w-0 flex-wrap items-center gap-2 lg:w-auto lg:shrink-0">{actions}</div>}
      {children}
    </div>
  );
}

export function SectionHeader({ title, subtitle, icon, actions, className = "" }: { title: React.ReactNode; subtitle?: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode; className?: string; }) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-2xl font-semibold leading-tight tracking-[-0.018em] text-ink">{icon}{title}</h2>
        {subtitle && <p className="mt-1 text-base leading-relaxed text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatStrip({ children, columns = 4, className = "" }: { children: React.ReactNode; columns?: 3 | 4; className?: string; }) {
  const grid = columns === 3 ? "sm:grid-cols-2 xl:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-4";
  return (
    <div className={`overflow-hidden rounded-2xl border border-edge/90 bg-edge-subtle shadow-card ${className}`}>
      <div className={`grid min-w-0 gap-px ${grid}`}>{children}</div>
    </div>
  );
}

export function StatItem({ label, value, sub, tone = "neutral", icon }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; icon: React.ReactNode; }) {
  return (
    <div className="min-w-0 bg-surface px-5 py-5 transition-colors hover:bg-surface-hover/40">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 break-words text-sm font-medium leading-normal text-ink-3">{label}</span>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-edge/80 bg-surface-2/80 text-ink-3">{icon}</span>
      </div>
      <div className="mt-3.5 flex items-center gap-2.5">
        <StatusDot tone={tone} pulse={tone === "ok"} />
        <span className="min-w-0 break-words text-3xl font-semibold leading-tight tracking-[-0.025em] text-ink tabular-nums">{value}</span>
      </div>
      {sub && <p className="mt-1.5 break-words text-xs leading-relaxed text-ink-3 tabular-nums">{sub}</p>}
    </div>
  );
}

type NoticeTone = "warn" | "ok" | "bad" | "info";
const noticeStyles: Record<NoticeTone, string> = {
  warn: "border-warn-edge/80 bg-warn-bg/90 text-warn",
  ok: "border-ok-edge/80 bg-ok-bg/90 text-ok",
  bad: "border-bad-edge/80 bg-bad-bg/90 text-bad",
  info: "border-info-edge/80 bg-info-bg/90 text-info",
};
const noticeIconStyles: Record<NoticeTone, string> = {
  warn: "text-warn", ok: "text-ok", bad: "text-bad", info: "text-info"
};

export function StatusNotice({ tone = "warn", icon, title, children, action, className = "" }: { tone?: NoticeTone; icon: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string; }) {
  return (
    <div role={tone === "bad" ? "alert" : "status"} aria-live={tone === "bad" ? "assertive" : "polite"} aria-atomic="true" className={`flex flex-col gap-3.5 rounded-2xl border p-5 shadow-xs sm:flex-row sm:items-center ${noticeStyles[tone]} ${className}`}>
      <span className={`shrink-0 ${noticeIconStyles[tone]}`}>{icon}</span>
      <div className="min-w-0 flex-1"><div className="break-words text-base font-semibold leading-snug">{title}</div>{children && <div className="mt-0.5 break-words text-sm leading-relaxed text-ink-2">{children}</div>}</div>
      {action && <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">{action}</div>}
    </div>
  );
}

export function PrinterAvatar({ name, size = "md", tone = "brand" }: { name: string; size?: "sm" | "md" | "lg"; tone?: Tone; }) {
  const dims = size === "lg" ? "h-10 w-10 text-xs" : size === "sm" ? "h-8 w-8 text-2xs" : "h-9 w-9 text-2xs";
  const toneClass = tone === "ok" ? "border-ok-edge bg-ok-bg text-ok" : tone === "bad" ? "border-bad-edge bg-bad-bg text-bad" : tone === "warn" ? "border-warn-edge bg-warn-bg text-warn" : "border-edge-accent bg-brand-subtle text-brand";
  const initials = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join("").toUpperCase();
  return <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-xl border font-semibold ${dims} ${toneClass}`}>{initials || "PR"}</span>;
}

export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0 rounded-2xl border border-edge/90 bg-surface p-4 shadow-card sm:p-5"><div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center">{children}</div></div>;
}

export function SettingsSection({ title, description, icon, children, className = "" }: { title: string; description?: string; icon: React.ReactNode; children: React.ReactNode; className?: string; }) {
  return (
    <section className={`overflow-hidden rounded-2xl border border-edge/90 bg-surface shadow-card ${className}`}>
      <div className="border-b border-edge/80 bg-surface-2/45 px-6 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-edge/80 bg-surface text-brand shadow-xs">{icon}</span>
          <div className="min-w-0"><h2 className="break-words text-lg font-semibold leading-snug tracking-[-0.015em] text-ink">{title}</h2>{description && <p className="mt-0.5 break-words text-sm leading-relaxed text-ink-3">{description}</p>}</div>
        </div>
      </div>
      <div className="space-y-5 px-6 py-6">{children}</div>
    </section>
  );
}


export function ViewAllButton({ label, onClick }: { label: string; onClick: () => void; }) {
  return <button type="button" onClick={onClick} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-medium text-ink-3 transition hover:bg-surface-2 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{label}<ChevronRight className="h-4 w-4 shrink-0 rtl:-scale-x-100" aria-hidden /></button>;
}
