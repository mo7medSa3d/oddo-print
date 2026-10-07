import React from "react";
import { ChevronRight } from "lucide-react";
import { StatusDot, type Tone } from "../components/ui";

export function PageHeader({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children?: React.ReactNode; }) {
  return (
    <header className="flex flex-col gap-4 border-b border-edge/80 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[22px] font-[620] leading-tight tracking-[-0.02em] text-ink">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      {children}
    </header>
  );
}

export function SectionHeader({ title, subtitle, icon, actions, className = "" }: { title: React.ReactNode; subtitle?: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode; className?: string; }) {
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-md font-[600] leading-tight tracking-[-0.012em] text-ink">{icon}{title}</h2>
        {subtitle && <p className="mt-1 text-sm leading-relaxed text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatStrip({ children, columns = 4, className = "" }: { children: React.ReactNode; columns?: 3 | 4; className?: string; }) {
  const grid = columns === 3 ? "sm:grid-cols-2 xl:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-4";
  return (
    <div className={`overflow-hidden rounded-sg border border-edge bg-edge-subtle shadow-xs ${className}`}>
      <div className={`grid gap-px ${grid}`}>{children}</div>
    </div>
  );
}

export function StatItem({ label, value, sub, tone = "neutral", icon }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; icon: React.ReactNode; }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-4 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-xs font-[550] text-ink-3">{label}</span>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-edge bg-surface-2 text-ink-3">{icon}</span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <StatusDot tone={tone} pulse={tone === "ok"} />
        <span className="min-w-0 truncate text-xl font-[650] leading-none tracking-[-0.02em] text-ink tabular-nums">{value}</span>
      </div>
      {sub && <p className="mt-1.5 truncate text-xs leading-relaxed text-ink-3">{sub}</p>}
    </div>
  );
}

export type NoticeTone = "warn" | "ok" | "bad" | "info";
const noticeStyles: Record<NoticeTone, string> = {
  warn: "border-warn-edge bg-warn-bg text-warn",
  ok: "border-ok-edge bg-ok-bg text-ok",
  bad: "border-bad-edge bg-bad-bg text-bad",
  info: "border-info-edge bg-info-bg text-info",
};
const noticeIconStyles: Record<NoticeTone, string> = {
  warn: "text-warn", ok: "text-ok", bad: "text-bad", info: "text-info"
};

export function StatusNotice({ tone = "warn", icon, title, children, action, className = "" }: { tone?: NoticeTone; icon: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string; }) {
  return (
    <div role="status" className={`flex flex-col gap-3 rounded-sg border p-4 sm:flex-row sm:items-start ${noticeStyles[tone]} ${className}`}>
      <span className={`mt-0.5 shrink-0 ${noticeIconStyles[tone]}`}>{icon}</span>
      <div className="min-w-0 flex-1"><div className="text-sm font-semibold leading-snug">{title}</div>{children && <div className="mt-1 text-sm leading-relaxed text-ink-2">{children}</div>}</div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function PrinterAvatar({ name, size = "md", tone = "brand" }: { name: string; size?: "sm" | "md" | "lg"; tone?: Tone; }) {
  const dims = size === "lg" ? "h-10 w-10 text-xs" : size === "sm" ? "h-8 w-8 text-2xs" : "h-9 w-9 text-2xs";
  const toneClass = tone === "ok" ? "border-ok-edge bg-ok-bg text-ok" : tone === "bad" ? "border-bad-edge bg-bad-bg text-bad" : tone === "warn" ? "border-warn-edge bg-warn-bg text-warn" : "border-edge-accent bg-brand-subtle text-brand";
  const initials = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join("").toUpperCase();
  return <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-sm border font-bold ${dims} ${toneClass}`}>{initials || "PR"}</span>;
}

export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="rounded-sg border border-edge bg-surface p-3.5"><div className="flex flex-col gap-3 lg:flex-row lg:items-center">{children}</div></div>;
}

export function SettingsSection({ title, description, icon, children, className = "" }: { title: string; description?: string; icon: React.ReactNode; children: React.ReactNode; className?: string; }) {
  return (
    <section className={`overflow-hidden rounded-sg border border-edge bg-surface shadow-card ${className}`}>
      <div className="border-b border-edge bg-surface-2/60 px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-edge bg-surface text-brand">{icon}</span>
          <div className="min-w-0"><h2 className="text-base font-semibold leading-tight tracking-[-0.015em] text-ink">{title}</h2>{description && <p className="mt-1 text-sm leading-relaxed text-ink-3">{description}</p>}</div>
        </div>
      </div>
      <div className="space-y-5 px-5 py-5">{children}</div>
    </section>
  );
}

export function DetailList({ rows, className = "" }: { rows: { label: string; value: React.ReactNode }[]; className?: string; }) {
  return <dl className={`divide-y divide-edge ${className}`}>
    {rows.map((r) => <div key={r.label} className="flex items-start justify-between gap-6 py-2.5">
      <dt className="shrink-0 text-xs text-ink-3">{r.label}</dt>
      <dd className="min-w-0 text-end text-sm font-medium text-ink">{r.value}</dd>
    </div>)}
  </dl>;
}

export function ViewAllButton({ label, onClick }: { label: string; onClick: () => void; }) {
  return <button type="button" onClick={onClick} className="inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-sm px-2 py-2.5 text-sm font-semibold text-ink-3 transition hover:bg-surface-2 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{label}<ChevronRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden /></button>;
}
