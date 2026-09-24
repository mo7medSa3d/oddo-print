import React from "react";
import { ChevronRight } from "lucide-react";
import { StatusDot, type Tone } from "../components/ui";

export function PageHeader({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children?: React.ReactNode; }) {
  return (
    <header className="flex flex-col gap-4 border-b border-edge/80 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-4">Yasser Print Manager</div>
        <h1 className="mt-1.5 text-[25px] font-bold leading-tight tracking-[-0.035em] text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-ink-3">{subtitle}</p>}
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
        <h2 className="flex items-center gap-2 text-[14px] font-semibold leading-tight tracking-[-0.015em] text-ink">{icon}{title}</h2>
        {subtitle && <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, sub, tone = "neutral", icon, footer }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; icon: React.ReactNode; footer?: React.ReactNode; }) {
  return (
    <div className="group rounded-[13px] border border-edge bg-surface p-5 shadow-card transition-all duration-150 hover:-translate-y-px hover:border-edge-accent hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-4">{label}</span>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-edge bg-surface-2 text-ink-3 transition-colors group-hover:text-brand">{icon}</span>
      </div>
      <div className="mt-4 flex items-baseline gap-2">
        <StatusDot tone={tone} pulse={tone === "ok"} />
        <span className="truncate text-[23px] font-bold leading-none tracking-[-0.025em] text-ink tabular-nums">{value}</span>
      </div>
      {sub && <p className="mt-2 truncate text-[12px] leading-relaxed text-ink-3">{sub}</p>}
      {footer && <div className="mt-4">{footer}</div>}
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
    <div role="status" className={`flex flex-col gap-3 rounded-[12px] border p-4 sm:flex-row sm:items-start ${noticeStyles[tone]} ${className}`}>
      <span className={`mt-0.5 shrink-0 ${noticeIconStyles[tone]}`}>{icon}</span>
      <div className="min-w-0 flex-1"><div className="text-[13px] font-semibold leading-snug">{title}</div>{children && <div className="mt-1 text-[12px] leading-relaxed opacity-85">{children}</div>}</div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function PrinterAvatar({ name, size = "md", tone = "brand" }: { name: string; size?: "sm" | "md" | "lg"; tone?: Tone; }) {
  const dims = size === "lg" ? "h-10 w-10 text-[12px]" : size === "sm" ? "h-8 w-8 text-[10px]" : "h-9 w-9 text-[11px]";
  const toneClass = tone === "ok" ? "border-ok-edge bg-ok-bg text-ok" : tone === "bad" ? "border-bad-edge bg-bad-bg text-bad" : tone === "warn" ? "border-warn-edge bg-warn-bg text-warn" : "border-edge-accent bg-brand-subtle text-brand";
  const initials = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join("").toUpperCase();
  return <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-[9px] border font-bold ${dims} ${toneClass}`}>{initials || "PR"}</span>;
}

export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[13px] border border-edge bg-surface p-3.5 shadow-xs"><div className="flex flex-col gap-3 lg:flex-row lg:items-center">{children}</div></div>;
}

export function SettingsSection({ title, description, icon, children, className = "" }: { title: string; description?: string; icon: React.ReactNode; children: React.ReactNode; className?: string; }) {
  return (
    <section className={`overflow-hidden rounded-[13px] border border-edge bg-surface shadow-card ${className}`}>
      <div className="border-b border-edge bg-surface-2/60 px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-edge bg-surface text-brand">{icon}</span>
          <div className="min-w-0"><h2 className="text-[14px] font-semibold leading-tight tracking-[-0.015em] text-ink">{title}</h2>{description && <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{description}</p>}</div>
        </div>
      </div>
      <div className="space-y-5 px-5 py-5">{children}</div>
    </section>
  );
}

export function DetailList({ rows, className = "" }: { rows: { label: string; value: React.ReactNode }[]; className?: string; }) {
  return <dl className={`divide-y divide-edge ${className}`}>
    {rows.map((r) => <div key={r.label} className="flex items-start justify-between gap-6 py-2.5">
      <dt className="shrink-0 text-[12px] text-ink-3">{r.label}</dt>
      <dd className="min-w-0 text-right text-[13px] font-medium text-ink">{r.value}</dd>
    </div>)}
  </dl>;
}

export function ViewAllButton({ label, onClick }: { label: string; onClick: () => void; }) {
  return <button onClick={onClick} className="inline-flex w-full items-center justify-center gap-1.5 rounded-[9px] py-2.5 text-[12px] font-semibold text-ink-3 transition hover:bg-surface-2 hover:text-brand">{label}<ChevronRight className="h-4 w-4" aria-hidden /></button>;
}
