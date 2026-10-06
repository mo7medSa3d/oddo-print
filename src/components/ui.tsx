"use client";

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n/react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  X,
  Check,
  Loader2,
  Copy,
  AlertTriangle,
  ChevronDown,
  CheckCircle2,
  Info,
  CircleSlash,
} from "lucide-react";

/* ============================================================
   YASEIR — UI primitives
   The single source for Button / Status / Surfaces / Forms /
   States / Overlays / Data display.

   Used by the Gateway (Next), the Platform control plane and the
   Desktop Manager (Vite), so every surface stays coherent.
   Behavior contracts (dialog isolation, field a11y, button links)
   are locked by tests — change visuals freely, not semantics.
   ============================================================ */

export { BrandMark } from "./brand";

import { jobTone as sharedJobTone, printerTone as sharedPrinterTone } from "../shared/job-vocabulary";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral" | "brand";

export const toneBg: Record<Tone, string> = {
  ok: "bg-ok-bg text-ok border-ok-edge",
  warn: "bg-warn-bg text-warn border-warn-edge",
  bad: "bg-bad-bg text-bad border-bad-edge",
  info: "bg-info-bg text-info border-info-edge",
  neutral: "bg-surface-2 text-ink-2 border-edge",
  brand: "bg-brand-subtle text-brand-subtle-text border-edge-accent",
};

const toneDotSolid: Record<Tone, string> = {
  ok: "bg-ok-solid",
  warn: "bg-warn-solid",
  bad: "bg-bad-solid",
  info: "bg-info-solid",
  neutral: "bg-ink-4",
  brand: "bg-brand",
};

const toneText: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  info: "text-info",
  neutral: "text-ink-3",
  brand: "text-brand",
};

const toneIconSurface: Record<Tone, string> = {
  ok: "border-ok-edge bg-ok-bg text-ok",
  warn: "border-warn-edge bg-warn-bg text-warn",
  bad: "border-bad-edge bg-bad-bg text-bad",
  info: "border-info-edge bg-info-bg text-info",
  neutral: "border-edge bg-surface-2 text-ink-3",
  brand: "border-edge-accent bg-brand-subtle text-brand",
};

export function agentTone(status: string): Tone {
  const s = String(status).toLowerCase();
  if (s === "online" || s === "running" || s === "active") return "ok";
  if (s === "offline" || s === "stopped" || s === "error" || s === "retired") return "bad";
  if (s === "disabled") return "warn";
  return "neutral";
}

export function printerTone(status: string): Tone {
  return sharedPrinterTone(String(status)) as Tone;
}

export function jobTone(status: string): Tone {
  return sharedJobTone(String(status)) as Tone;
}

/** Focus treatment shared by every interactive control. */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-1 focus-visible:ring-offset-app";

/* ============================================================
   Buttons
   ============================================================ */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "subtle";

const buttonVariants: Record<ButtonVariant, string> = {
  // Solid label background: white on --brand-solid stays >= 4.5:1 in both
  // themes (5.2:1 light, 4.7:1 dark). Hover darkens instead of lightening so
  // the label contrast only improves while pressed.
  primary:
    "bg-brand-solid text-brand-contrast border border-transparent shadow-xs hover:brightness-[0.94] active:brightness-[0.88] active:shadow-none",
  secondary:
    "bg-surface text-ink border border-edge-strong shadow-xs hover:bg-surface-2 hover:border-ink-4/60 active:bg-surface-3",
  subtle:
    "bg-surface-2 text-ink border border-transparent hover:bg-surface-3 active:bg-surface-3",
  ghost:
    "bg-transparent text-ink-2 border border-transparent hover:bg-surface-2 hover:text-ink active:bg-surface-3",
  danger:
    "bg-bad-solid text-on-solid border border-transparent shadow-xs hover:brightness-[0.95] active:brightness-[0.9]",
  success:
    "bg-ok-solid text-on-solid border border-transparent shadow-xs hover:brightness-[0.95] active:brightness-[0.9]",
};

const buttonSizes: Record<"sm" | "md" | "lg", string> = {
  sm: "h-8 px-2.5 text-xs gap-1.5 rounded-sm",
  md: "h-9 px-3.5 text-sm gap-1.5 rounded-sm",
  lg: "h-11 px-5 text-base gap-2 rounded-md",
};

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: React.ReactNode;
  href?: string;
  target?: string;
  rel?: string;
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  href,
  target,
  rel,
  disabled,
  ...props
}: ButtonProps) {
  const baseClasses = `relative inline-flex select-none items-center justify-center whitespace-nowrap font-[560] tracking-[-0.01em] transition-[background-color,border-color,box-shadow,transform,opacity] duration-150 ease-out disabled:pointer-events-none disabled:opacity-45 ${focusRing} ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`;

  const content = (
    <>
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        // Icon slots are decorative: every control carries its meaning as text
        // (or an explicit aria-label for icon-only buttons).
        icon && <span aria-hidden className="inline-flex shrink-0 items-center">{icon}</span>
      )}
      {children}
    </>
  );

  if (href) {
    const linkDisabled = loading || disabled;
    const handleLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (linkDisabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      props.onClick?.(event as unknown as React.MouseEvent<HTMLButtonElement>);
    };

    return (
      <Link
        href={href}
        target={target}
        rel={rel}
        className={`${baseClasses} ${linkDisabled ? "pointer-events-none opacity-45" : ""}`}
        aria-disabled={linkDisabled || undefined}
        aria-busy={loading || undefined}
        tabIndex={linkDisabled ? -1 : props.tabIndex}
        onClick={handleLinkClick}
        title={props.title}
        id={props.id}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      /* Default to a non-submitting button: inside a form, only an explicit
         type="submit" should trigger submission. */
      type={props.type ?? "button"}
      className={baseClasses}
      disabled={loading || disabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {content}
    </button>
  );
}

export function IconButton({
  label,
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-45 ${focusRing} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <Loader2 className={`h-4 w-4 animate-spin text-ink-3 ${className}`} aria-hidden />;
}

/* ============================================================
   Status
   ============================================================ */

export function StatusDot({
  tone,
  pulse = false,
  className = "",
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span aria-hidden className={`status-dot ${toneDotSolid[tone]} ${className}`} data-live={pulse ? "true" : undefined} />
  );
}

/**
 * Status pill: color is never the only signal — every badge pairs the tone
 * with a dot (or icon) and a text label so it survives color-blind rendering
 * and forced-colors mode.
 */
export function StatusBadge({
  tone = "neutral",
  label,
  icon,
  pulse,
  size = "md",
  className = "",
}: {
  tone?: Tone;
  label: string;
  icon?: React.ReactNode;
  pulse?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const dims = size === "sm" ? "h-5 px-1.5 text-2xs gap-1" : "h-6 px-2 text-2xs gap-1.5";
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-sm border font-[600] tracking-[0.005em] ${dims} ${toneBg[tone]} ${className}`}
    >
      {icon ? (
        <span className="flex h-3 w-3 items-center justify-center" aria-hidden>
          {icon}
        </span>
      ) : (
        <StatusDot tone={tone} pulse={pulse} className={size === "sm" ? "h-1.5 w-1.5" : ""} />
      )}
      {label}
    </span>
  );
}

export function Progress({
  value,
  tone = "brand",
  label,
  indeterminate = false,
  className = "",
}: {
  value?: number;
  tone?: Tone;
  label?: string;
  indeterminate?: boolean;
  className?: string;
}) {
  const pct = Math.min(100, Math.max(0, value ?? 0));
  return (
    <div
      className={`progress-track h-1.5 w-full ${indeterminate ? "progress-indeterminate" : ""} ${className}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : pct}
    >
      {!indeterminate && (
        <div className="progress-bar" style={{ width: `${pct}%`, background: tone === "brand" ? undefined : `var(--${tone === "ok" ? "success-solid" : tone === "warn" ? "warning-solid" : tone === "bad" ? "danger-solid" : tone === "info" ? "info-solid" : "text-4"})` }} />
      )}
    </div>
  );
}

/* ============================================================
   Surfaces
   ============================================================ */

export function Card({
  children,
  className = "",
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div id={id} className={`card ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  icon,
  className = "",
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-3 border-b border-edge-subtle px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${className}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-edge bg-surface-2 text-ink-3">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="truncate text-md font-[600] leading-snug tracking-[-0.012em] text-ink">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-sm leading-snug text-ink-3">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Flat grouping surface that sits inside a card or directly on the page. */
export function Panel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`panel ${className}`}>{children}</div>;
}

export function Section({
  title,
  description,
  actions,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      {(title || description || actions) && (
        <header className="flex flex-col gap-3 border-b border-edge-subtle px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {title && (
              <h2 className="text-md font-[600] leading-snug tracking-[-0.012em] text-ink">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-sm leading-relaxed text-ink-3">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`px-5 py-5 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function StatCard({
  title,
  value,
  subtitle,
  icon,
  tone = "neutral",
  trend,
  footer,
  className = "",
}: {
  title: string;
  value: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: Tone;
  trend?: { text: string; positive?: boolean };
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`group relative rounded-xl border border-edge bg-surface p-4 shadow-card transition-[border-color,box-shadow,transform] duration-[200ms] ease-out hover:-translate-y-px hover:border-edge-strong hover:shadow-card-hover ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="label-caps text-ink-3">{title}</span>
        {icon && (
          <span
            aria-hidden
            className={`flex h-7 w-7 items-center justify-center rounded-sm border ${toneIconSurface[tone]}`}
          >
            {icon}
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-2xl font-[640] leading-none tracking-[-0.02em] text-ink tabular">
          {value}
        </span>
        {trend && (
          <span
            className={`text-2xs font-[600] ${trend.positive === false ? "text-bad" : "text-ok"}`}
          >
            {trend.text}
          </span>
        )}
      </div>
      {subtitle && <div className="mt-1.5 text-sm leading-snug text-ink-3">{subtitle}</div>}
      {footer && <div className="mt-3 border-t border-edge-subtle pt-3">{footer}</div>}
    </div>
  );
}

/* ---------- Financial surfaces (billing) ---------- */

export function BillingPremiumCard({
  plan,
  status,
  balance,
  usagePercent,
  renewal,
  actions,
  entitlements,
}: {
  plan: string;
  status?: string;
  balance?: string;
  usagePercent?: number;
  renewal?: string;
  actions?: React.ReactNode;
  entitlements?: Array<{ label: string; value: string }>;
}) {
  const { t } = useI18n();
  return (
    <div className="billing-premium p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 rounded-sm border border-edge-accent bg-brand-subtle px-2 py-0.5 text-2xs font-[600] tracking-[0.02em] text-brand-subtle-text">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
            {t("ui.currentPlan")}
          </div>
          <div className="mt-2.5 text-xl font-[640] tracking-[-0.02em] text-ink">{plan}</div>
          {status && <div className="mt-0.5 text-sm text-ink-3">{status}</div>}
        </div>
        {balance && (
          <div className="text-end">
            <div className="label-caps text-ink-3">{t("ui.balance")}</div>
            <div className="mt-1 text-2xl font-[640] tracking-[-0.02em] text-ink tabular">{balance}</div>
          </div>
        )}
      </div>

      {typeof usagePercent === "number" && (
        <div className="mt-5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-3">{t("ui.usageThisPeriod")}</span>
            <span className="font-[600] text-ink tabular">{usagePercent}%</span>
          </div>
          <Progress value={usagePercent} label={t("ui.planUsage")} className="mt-2" tone={usagePercent >= 90 ? "warn" : "brand"} />
        </div>
      )}

      {entitlements && entitlements.length > 0 && (
        <dl className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {entitlements.slice(0, 6).map((e) => (
            <div key={e.label} className="rounded-md border border-edge-subtle bg-surface-2 px-3 py-2">
              <dt className="label-caps text-ink-3">{e.label}</dt>
              <dd className="mt-0.5 text-sm font-[600] text-ink tabular">{e.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {renewal && <div className="mt-4 text-sm text-ink-3">{renewal}</div>}

      {actions && <div className="mt-5 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function BalanceCard({
  amount,
  subtitle,
  trend,
  actions,
  footer,
}: {
  amount: React.ReactNode;
  subtitle?: React.ReactNode;
  trend?: string;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="balance-card p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="label-caps text-ink-3">{t("ui.currentBalance")}</div>
          <div className="mt-2 text-3xl font-[640] tracking-[-0.025em] leading-none text-ink tabular">
            {amount}
          </div>
          {subtitle && <div className="mt-2 text-sm text-ink-3">{subtitle}</div>}
        </div>
        {trend && (
          <StatusBadge tone="ok" label={trend} />
        )}
      </div>
      {actions && <div className="mt-5 flex flex-wrap gap-2">{actions}</div>}
      {footer && (
        <div className="mt-5 border-t border-edge-subtle pt-4 text-sm text-ink-3">{footer}</div>
      )}
    </div>
  );
}

/* ============================================================
   States — loading / empty / error / informational
   ============================================================ */

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  size = "md",
  className = "",
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  size?: "sm" | "md";
  className?: string;
}) {
  const pad = size === "sm" ? "px-5 py-8" : "px-6 py-12 sm:py-14";
  const tile = size === "sm" ? "h-10 w-10 rounded-md" : "h-12 w-12 rounded-lg";
  return (
    <div className={`flex flex-col items-center justify-center text-center ${pad} ${className}`}>
      <div
        aria-hidden
        className={`flex items-center justify-center border border-edge-subtle bg-surface-2 text-ink-3 ${tile}`}
      >
        {icon}
      </div>
      <h3 className="mt-3.5 text-md font-[600] tracking-[-0.012em] text-ink">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-[46ch] text-sm leading-relaxed text-ink-3">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  retry,
  tone = "bad",
  className = "",
}: {
  title?: string;
  message: string;
  retry?: () => void;
  tone?: "bad" | "warn";
  className?: string;
}) {
  const { t } = useI18n();
  const icon = tone === "warn" ? AlertTriangle : CircleSlash;
  const Icon = icon;
  return (
    <div
      role="alert"
      className={`flex flex-col gap-3 rounded-sg border px-4 py-3.5 sm:flex-row sm:items-start ${
        tone === "warn" ? "border-warn-edge bg-warn-bg text-warn" : "border-bad-edge bg-bad-bg text-bad"
      } ${className}`}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-[600]">{title ?? t("ui.somethingWentWrong")}</div>
        <p className="mt-0.5 break-words text-sm leading-relaxed text-ink-2">{message}</p>
      </div>
      {retry && (
        <Button size="sm" variant="secondary" onClick={retry} className="shrink-0">
          {t("common.tryAgain")}
        </Button>
      )}
    </div>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
  action,
  icon,
  className = "",
}: {
  tone?: Tone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  const fallback =
    tone === "ok" ? (
      <CheckCircle2 className="h-4 w-4" aria-hidden />
    ) : tone === "info" || tone === "brand" ? (
      <Info className="h-4 w-4" aria-hidden />
    ) : (
      <AlertTriangle className="h-4 w-4" aria-hidden />
    );
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      className={`flex flex-col gap-3 rounded-sg border px-4 py-3.5 sm:flex-row sm:items-start ${toneBg[tone]} ${className}`}
    >
      <span aria-hidden className={`mt-0.5 shrink-0 ${toneText[tone]}`}>{icon ?? fallback}</span>
      <div className="min-w-0 flex-1">
        {title && <div className="text-sm font-[600] leading-snug">{title}</div>}
        {children && (
          <div className="mt-0.5 text-sm leading-relaxed text-ink-2">{children}</div>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function LoadingState({
  rows = 3,
  className = "",
  label,
}: {
  rows?: number;
  className?: string;
  label?: string;
}) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={label ?? t("ui.loading")} className={`space-y-2.5 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-9" style={{ width: `${100 - (i % 3) * 12}%` }} />
      ))}
      <span className="sr-only">{(label ?? t("ui.loading")).replace(/…+$/, "")}…</span>
    </div>
  );
}

/** Skeleton shaped like the table it replaces — no layout shift on load. */
export function TableSkeleton({
  rows = 6,
  columns = 4,
  className = "",
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("ui.loadingRecords")} className={`w-full ${className}`}>
      <div className="flex items-center gap-4 border-b border-edge bg-surface-2 px-4 py-2.5">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-2.5 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-edge-subtle px-4 py-3.5">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className={`h-3 flex-1 ${c === 0 ? "max-w-[180px]" : ""}`} />
          ))}
        </div>
      ))}
      <span className="sr-only">{t("ui.loadingRecords")}…</span>
    </div>
  );
}

export function PageSkeleton({
  className = "",
  withHeader = true,
}: {
  className?: string;
  withHeader?: boolean;
}) {
  return (
    <div className={`space-y-6 ${className}`}>
      {withHeader && (
        <div className="space-y-3">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[360px] rounded-2xl" />
    </div>
  );
}

/* ============================================================
   Forms
   ============================================================ */

type FieldContextValue = {
  controlId: string;
  descriptionId?: string;
  invalid: boolean;
};

const FieldContext = React.createContext<FieldContextValue | null>(null);

export function Field({
  label,
  hint,
  htmlFor,
  error,
  required,
  optional,
  children,
  className = "",
  actions,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  error?: string;
  required?: boolean;
  optional?: boolean;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
}) {
  const { t } = useI18n();
  const generatedId = useId();
  const controlId = htmlFor ?? `field-${generatedId}`;
  const descriptionId = error
    ? `${controlId}-error`
    : hint
      ? `${controlId}-hint`
      : undefined;

  return (
    <FieldContext.Provider value={{ controlId, descriptionId, invalid: Boolean(error) }}>
      <div className={className}>
        <div className="flex items-baseline justify-between gap-3">
          <label
            htmlFor={controlId}
            className="block text-sm font-[550] tracking-[-0.005em] text-ink-2"
          >
            {label}
            {required && (
              <span className="ms-1 text-bad" aria-hidden>
                *
              </span>
            )}
            {optional && !required && (
              <span className="ms-1.5 text-xs font-normal text-ink-4">{t("ui.optional")}</span>
            )}
          </label>
          {actions}
        </div>
        <div className="mt-1.5">{children}</div>
        {error && (
          <p id={descriptionId} className="mt-1.5 flex items-start gap-1.5 text-sm font-[500] text-bad">
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={descriptionId} className="mt-1.5 text-sm leading-relaxed text-ink-3">
            {hint}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

export const inputClass =
  "w-full h-10 rounded-sm border border-control bg-surface px-3 text-base text-ink placeholder:text-ink-4 shadow-xs transition-[border-color,box-shadow,background-color] duration-150 ease-out hover:border-ink-4/70 focus:border-brand focus:outline-none focus:ring-[3px] focus:ring-brand/18 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3";

function useFieldProps({
  id,
  error,
  ariaDescribedBy,
  ariaInvalid,
}: {
  id?: string;
  error?: boolean;
  ariaDescribedBy?: string;
  ariaInvalid?: React.AriaAttributes["aria-invalid"];
}) {
  const field = React.useContext(FieldContext);
  const invalid = error ?? field?.invalid ?? false;
  return {
    id: id ?? field?.controlId,
    "aria-invalid": ariaInvalid ?? (invalid || undefined),
    "aria-describedby": ariaDescribedBy ?? field?.descriptionId,
    invalid,
  };
}

export function Input({
  className = "",
  error,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { error?: boolean }) {
  const resolved = useFieldProps({ id, error, ariaDescribedBy, ariaInvalid });

  return (
    <input
      id={resolved.id}
      aria-invalid={resolved["aria-invalid"]}
      aria-describedby={resolved["aria-describedby"]}
      className={`${inputClass} ${resolved.invalid ? "border-bad-edge focus:border-bad focus:ring-bad/15" : ""} ${className}`}
      {...props}
    />
  );
}

export function Textarea({
  className = "",
  error,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: boolean }) {
  const resolved = useFieldProps({ id, error, ariaDescribedBy, ariaInvalid });

  return (
    <textarea
      id={resolved.id}
      aria-invalid={resolved["aria-invalid"]}
      aria-describedby={resolved["aria-describedby"]}
      className={`${inputClass} h-auto min-h-[92px] resize-y py-2 leading-relaxed ${
        resolved.invalid ? "border-bad-edge focus:border-bad focus:ring-bad/15" : ""
      } ${className}`}
      {...props}
    />
  );
}

export function Select({
  className = "",
  error,
  children,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { error?: boolean }) {
  const resolved = useFieldProps({ id, error, ariaDescribedBy, ariaInvalid });

  return (
    <span className={`relative inline-flex w-full items-center [&>svg]:pointer-events-none ${className}`}>
      <select
        id={resolved.id}
        aria-invalid={resolved["aria-invalid"]}
        aria-describedby={resolved["aria-describedby"]}
        className={`${inputClass} cursor-pointer appearance-none pe-8 ${
          resolved.invalid ? "border-bad-edge focus:border-bad focus:ring-bad/15" : ""
        }`}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="absolute end-2.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
    </span>
  );
}

export function Checkbox({
  label,
  description,
  className = "",
  id,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: React.ReactNode;
  description?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? `checkbox-${generatedId}`;
  const descId = description ? `${inputId}-description` : undefined;
  return (
    <div className={`flex items-start gap-2.5 ${className}`}>
      <input
        id={inputId}
        type="checkbox"
        aria-describedby={descId}
        className={`mt-0.5 h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-xs border border-control bg-surface transition-colors duration-[120ms] checked:border-brand checked:bg-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-1 focus-visible:ring-offset-app disabled:cursor-not-allowed disabled:opacity-50`}
        {...props}
      />
      <div className="min-w-0">
        <label htmlFor={inputId} className="block cursor-pointer text-sm font-[500] text-ink">
          {label}
        </label>
        {description && (
          <p id={descId} className="mt-0.5 text-sm leading-relaxed text-ink-3">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Data display
   ============================================================ */

export function Mono({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <code
      className={`font-mono text-xs tracking-[-0.01em] text-ink-3 ${className}`}
      title={typeof children === "string" ? children : undefined}
    >
      {children}
    </code>
  );
}

export function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-2.5">
      <dt className="shrink-0 text-sm text-ink-3">{label}</dt>
      <dd className="min-w-0 text-end text-sm font-[550] text-ink">{children}</dd>
    </div>
  );
}

export function KeyValueList({
  rows,
  className = "",
  dense = false,
}: {
  rows: Array<{ label: string; value: React.ReactNode }>;
  className?: string;
  dense?: boolean;
}) {
  return (
    <dl className={`divide-y divide-edge-subtle ${className}`}>
      {rows.map((row, i) => (
        <div
          key={`${row.label}-${i}`}
          className={`flex items-start justify-between gap-6 ${dense ? "py-2" : "py-2.5"}`}
        >
          <dt className="shrink-0 text-sm text-ink-3">{row.label}</dt>
          <dd className="min-w-0 text-end text-sm font-[550] text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DataTableShell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`overflow-hidden rounded-xl border border-edge bg-surface ${className}`}>
      {children}
    </div>
  );
}

export function TableScroll({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`w-full overflow-x-auto [scrollbar-gutter:stable] ${className}`}>
      <table className="data-table text-base">{children}</table>
    </div>
  );
}

export function CopyButton({
  value,
  onCopied,
  label,
  className = "",
}: {
  value: string;
  onCopied?: () => void;
  label?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  return (
    <button
      type="button"
      aria-label={label ?? t("ui.copy")}
      title={label ?? t("ui.copy")}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          setCopyFailed(false);
          await navigator.clipboard.writeText(value);
          setCopied(true);
          onCopied?.();
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
          setCopyFailed(true);
          setTimeout(() => setCopyFailed(false), 2500);
        }
      }}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-edge bg-surface px-2 text-xs font-[550] text-ink-2 transition-colors duration-150 hover:border-edge-strong hover:bg-surface-2 hover:text-ink ${focusRing} ${className}`}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 text-ok" aria-hidden />
          <span className="text-ok">{t("ui.copied")}</span>
        </>
      ) : copyFailed ? (
        <>
          <AlertTriangle className="h-3 w-3 text-bad" aria-hidden />
          <span className="text-bad">{t("ui.copyFailed")}</span>
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" aria-hidden />
          {label ?? t("ui.copy")}
        </>
      )}
    </button>
  );
}

export function Avatar({
  name,
  size = "md",
  tone = "brand",
  className = "",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  tone?: Tone;
  className?: string;
}) {
  const dims =
    size === "lg" ? "h-9 w-9 text-sm" : size === "sm" ? "h-6 w-6 text-2xs" : "h-7 w-7 text-xs";
  const initials = name
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-sm border font-[650] ${dims} ${toneIconSurface[tone]} ${className}`}
    >
      {initials || "?"}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/* ============================================================
   Overlays — Tooltip / Menu / Tabs / Segmented control
   ============================================================ */

export function Tooltip({
  label,
  children,
  side = "top",
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  side?: "top" | "bottom";
  className?: string;
}) {
  const id = useId();
  const position =
    side === "top"
      ? "bottom-[calc(100%+6px)] start-1/2 ltr:-translate-x-1/2 rtl:translate-x-1/2"
      : "top-[calc(100%+6px)] start-1/2 ltr:-translate-x-1/2 rtl:translate-x-1/2";
  return (
    <span className={`group/tooltip relative inline-flex ${className}`} aria-describedby={id}>
      {children}
      <span
        role="tooltip"
        id={id}
        className={`pointer-events-none absolute z-50 hidden max-w-[240px] whitespace-nowrap rounded-sm border border-edge-strong bg-surface-elevated px-2 py-1 text-xs font-[500] text-ink shadow-md group-hover/tooltip:block group-focus-within/tooltip:block ${position}`}
      >
        {label}
      </span>
    </span>
  );
}

export type MenuItemSpec = {
  key: string;
  label: string;
  icon?: React.ReactNode;
  onSelect?: () => void;
  href?: string;
  tone?: "default" | "danger";
  disabled?: boolean;
  separatorBefore?: boolean;
  meta?: string;
};

/**
 * Accessible dropdown menu (ARIA menu pattern) used for row actions,
 * account controls and other progressive-disclosure surfaces.
 */
export function Menu({
  items,
  trigger,
  label,
  align = "end",
  placement = "below",
  className = "",
  menuClassName = "",
}: {
  items: MenuItemSpec[];
  trigger: React.ReactNode;
  label: string;
  align?: "start" | "end";
  placement?: "below" | "above";
  className?: string;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [floatingPosition, setFloatingPosition] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusPendingRef = useRef(false);

  const close = useCallback((restoreFocus = true) => {
    focusPendingRef.current = false;
    setOpen(false);
    setFloatingPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const updateFloatingPosition = useCallback(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const viewportPadding = 8;
    const gap = 6;
    const roomBelow = Math.max(0, viewportHeight - triggerRect.bottom - gap - viewportPadding);
    const roomAbove = Math.max(0, triggerRect.top - gap - viewportPadding);
    const naturalHeight = Math.max(menuRect.height, menuRef.current.scrollHeight);

    let resolvedPlacement = placement;
    if (placement === "below" && naturalHeight > roomBelow && roomAbove > roomBelow) {
      resolvedPlacement = "above";
    } else if (placement === "above" && naturalHeight > roomAbove && roomBelow > roomAbove) {
      resolvedPlacement = "below";
    }

    const availableHeight = resolvedPlacement === "below" ? roomBelow : roomAbove;
    const maxHeight = Math.max(0, availableHeight);
    const renderedHeight = Math.min(naturalHeight, maxHeight);
    const top =
      resolvedPlacement === "below"
        ? Math.min(triggerRect.bottom + gap, viewportHeight - viewportPadding)
        : Math.max(viewportPadding, triggerRect.top - gap - renderedHeight);

    const direction = window.getComputedStyle(triggerRef.current).direction;
    const isRtl = direction === "rtl";
    const menuWidth = Math.min(menuRect.width, Math.max(0, viewportWidth - viewportPadding * 2));
    let left: number;

    if (align === "end") {
      left = isRtl ? triggerRect.left : triggerRect.right - menuWidth;
    } else {
      left = isRtl ? triggerRect.right - menuWidth : triggerRect.left;
    }

    left = Math.max(viewportPadding, Math.min(left, viewportWidth - menuWidth - viewportPadding));
    setFloatingPosition({ top, left, maxHeight });
  }, [align, open, placement]);

  useEffect(() => {
    if (!open) return;

    let frame = window.requestAnimationFrame(updateFloatingPosition);
    const onViewportChange = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateFloatingPosition);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      window.cancelAnimationFrame(frame);
    };
  }, [open, close, updateFloatingPosition]);

  useEffect(() => {
    if (!open || !floatingPosition || !focusPendingRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (!focusPendingRef.current) return;
      focusPendingRef.current = false;
      const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
      first?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, floatingPosition]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const nodes = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    );
    if (nodes.length === 0) return;
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      nodes[(index + 1 + nodes.length) % nodes.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      nodes[(index - 1 + nodes.length) % nodes.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      nodes[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      nodes[nodes.length - 1]?.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  const menuNode =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            style={{
              position: "fixed",
              top: floatingPosition?.top ?? 0,
              left: floatingPosition?.left ?? 0,
              maxHeight: floatingPosition?.maxHeight,
              visibility: floatingPosition ? "visible" : "hidden",
            }}
            className={`yz-menu-in menu-surface z-50 min-w-[210px] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain p-1.5 ${menuClassName}`}
          >
            {items.map((item) => (
              <React.Fragment key={item.key}>
                {item.separatorBefore && <div className="my-1 h-px bg-edge-subtle" role="separator" />}
                {item.href ? (
                  <Link
                    href={item.href}
                    role="menuitem"
                    tabIndex={-1}
                    aria-disabled={item.disabled || undefined}
                    data-variant={item.tone === "danger" ? "danger" : undefined}
                    className="menu-item"
                    onClick={() => close(false)}
                  >
                    {item.icon && <span className="shrink-0 text-ink-3">{item.icon}</span>}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.meta && <span className="shrink-0 text-xs text-ink-4">{item.meta}</span>}
                  </Link>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={item.disabled}
                    aria-disabled={item.disabled || undefined}
                    data-variant={item.tone === "danger" ? "danger" : undefined}
                    className="menu-item disabled:pointer-events-none disabled:opacity-45"
                    onClick={() => {
                      close(false);
                      item.onSelect?.();
                    }}
                  >
                    {item.icon && <span className="shrink-0 text-ink-3">{item.icon}</span>}
                    <span className="min-w-0 flex-1 truncate text-start">{item.label}</span>
                    {item.meta && <span className="shrink-0 text-xs text-ink-4">{item.meta}</span>}
                  </button>
                )}
              </React.Fragment>
            ))}
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={rootRef} className={`relative inline-flex ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          if (open) close(false);
          else {
            focusPendingRef.current = true;
            setFloatingPosition(null);
            setOpen(true);
          }
        }}
        className={`inline-flex w-full items-center ${focusRing}`}
      >
        {trigger}
      </button>
      {menuNode}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  counts,
  labels,
  ariaLabel,
  className = "",
}: {
  tabs: readonly T[];
  active: T;
  onChange: (t: T) => void;
  counts?: Partial<Record<T, number>>;
  labels?: Partial<Record<T, string>>;
  ariaLabel?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const idx = tabs.indexOf(active);
    let next = idx;
    // In RTL the visual order is mirrored, so "move right" must mean "previous
    // tab" — otherwise the arrow keys fight the reading direction.
    const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const backward = rtl ? "ArrowRight" : "ArrowLeft";
    if (e.key === forward) next = (idx + 1) % tabs.length;
    else if (e.key === backward) next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next !== idx) {
      onChange(tabs[next]);
      requestAnimationFrame(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-tab="${tabs[next]}"]`)?.focus();
      });
    }
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel ?? t("ui.filterOptions")}
      onKeyDown={onListKeyDown}
      className={`flex items-center gap-1 overflow-x-auto ${className}`}
    >
      {tabs.map((t) => {
        const selected = t === active;
        const count = counts?.[t];
        return (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-tab={t}
            onClick={() => onChange(t)}
            className={`relative flex shrink-0 items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-sm font-[550] capitalize transition-colors duration-150 ${focusRing} ${
              selected
                ? "bg-surface text-ink shadow-xs ring-1 ring-inset ring-edge"
                : "text-ink-3 hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {labels?.[t] ?? t}
            {count !== undefined && (
              <span
                className={`rounded-xs px-1 text-2xs font-[600] tabular ${
                  selected ? "bg-brand-subtle text-brand-subtle-text" : "bg-surface-2 text-ink-3"
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  className = "",
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string; icon?: React.ReactNode }>;
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const pad = size === "sm" ? "p-0.5" : "p-0.5";
  const item = size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-2.5 text-sm";
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex items-center gap-0.5 rounded-md border border-edge bg-surface-2 ${pad} ${className}`}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={`inline-flex items-center gap-1.5 rounded-sm font-[550] transition-[background-color,color,box-shadow] duration-150 ${item} ${focusRing} ${
              selected
                ? "bg-surface text-ink shadow-xs"
                : "text-ink-3 hover:text-ink"
            }`}
          >
            {option.icon}
            {option.label && <span className="hidden sm:inline">{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================
   Modal / Drawer
   ============================================================ */

const inertedBackground = new Map<HTMLElement, boolean>();
const dialogStack: HTMLDivElement[] = [];
let openDialogCount = 0;
let bodyLockScrollY = 0;
let bodyLockStyles: { position: string; top: string; width: string; overflow: string } | null = null;

function lockBodyScroll(): void {
  if (typeof document === "undefined" || bodyLockStyles) return;
  const body = document.body;
  bodyLockScrollY = window.scrollY;
  bodyLockStyles = {
    position: body.style.position,
    top: body.style.top,
    width: body.style.width,
    overflow: body.style.overflow,
  };
  body.style.position = "fixed";
  body.style.top = `-${bodyLockScrollY}px`;
  body.style.width = "100%";
  body.style.overflow = "hidden";
}

function unlockBodyScroll(): void {
  if (typeof document === "undefined" || !bodyLockStyles) return;
  const body = document.body;
  body.style.position = bodyLockStyles.position;
  body.style.top = bodyLockStyles.top;
  body.style.width = bodyLockStyles.width;
  body.style.overflow = bodyLockStyles.overflow;
  bodyLockStyles = null;
  window.scrollTo(0, bodyLockScrollY);
}

function refreshBackgroundIsolation(): void {
  if (typeof document === "undefined") return;
  inertedBackground.forEach((wasInert, element) => { element.inert = wasInert; });
  inertedBackground.clear();
  const panel = dialogStack[dialogStack.length - 1];
  let element: HTMLElement | null = panel?.closest<HTMLElement>("[data-dialog-root]") ?? panel ?? null;
  while (element && element !== document.body) {
    const parent: HTMLElement | null = element.parentElement;
    if (!parent) break;
    for (const sibling of [...parent.children]) {
      if (sibling instanceof HTMLElement && sibling !== element) {
        inertedBackground.set(sibling, Boolean(sibling.inert)); sibling.inert = true;
      }
    }
    element = parent;
  }
}

export function useDialog(
  open: boolean,
  onClose: () => void,
  panelRef: React.RefObject<HTMLDivElement | null>
) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    if (openDialogCount === 0) lockBodyScroll();
    dialogStack.push(panel);
    openDialogCount = dialogStack.length;
    refreshBackgroundIsolation();
    const focusables = (): HTMLElement[] => {
      const panel = panelRef.current;
      if (!panel) return [];
      const nodes = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const visible = [...nodes].filter((el) => el.offsetParent !== null);
      return visible.length > 0 ? visible : [...nodes];
    };
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== panel) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!panel.contains(document.activeElement)) {
        e.preventDefault(); first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      const wasTop = dialogStack[dialogStack.length - 1] === panel;
      const index = dialogStack.indexOf(panel);
      if (index !== -1) dialogStack.splice(index, 1);
      openDialogCount = dialogStack.length;
      refreshBackgroundIsolation();
      if (openDialogCount === 0) unlockBodyScroll();
      if (wasTop && prev?.isConnected && !prev.closest("[inert]")) prev.focus();
    };
  }, [open, panelRef]);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const descId = useId();
  useDialog(open, onClose, panelRef);
  if (!open || typeof document === "undefined") return null;
  // Portaled to document.body so viewport centering, fixed positioning, and
  // overflow are never affected by dashboard transforms, filters,
  // flex/grid parents, or page height. The outer layer scrolls when the
  // viewport is short; the inner body region scrolls for long content.
  const node = (
    <div
      data-dialog-root
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4 sm:p-6"
      role="presentation"
    >
      <div
        className="pg-fade-in fixed inset-0 backdrop-blur-[2px]"
        style={{ backgroundColor: "var(--overlay)" }}
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`pg-scale-in relative my-auto flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-2xl border border-edge-strong bg-surface shadow-2xl outline-none sm:max-h-[calc(100dvh-3rem)] ${
          wide ? "sm:max-w-3xl" : "sm:max-w-[480px]"
        }`}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-edge-subtle px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 className="text-md font-[600] tracking-[-0.012em] text-ink">{title}</h2>
            {description && (
              <p id={descId} className="mt-1 text-sm leading-relaxed text-ink-3">
                {description}
              </p>
            )}
          </div>
          <IconButton label={t("ui.closeDialog")} onClick={onClose} className="-me-1 shrink-0">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-5 sm:px-6">
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-edge-subtle bg-surface-2 px-5 py-4 sm:px-6">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "danger",
  busy = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => void onConfirm()}
            loading={busy}
            disabled={busy}
          >
            {confirmLabel ?? t("ui.confirm")}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const descId = useId();
  useDialog(open, onClose, panelRef);
  if (!open || typeof document === "undefined") return null;
  const node = (
    <div data-dialog-root className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <div
        className="pg-fade-in fixed inset-0"
        style={{ backgroundColor: "var(--overlay)" }}
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className="pg-slide-in-right relative flex h-full max-h-dvh w-full max-w-[480px] flex-col border-s border-edge-strong bg-surface shadow-2xl outline-none"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-edge-subtle px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 className="text-md font-[600] tracking-[-0.012em] text-ink">{title}</h2>
            {description && (
              <p id={descId} className="mt-1 text-sm text-ink-3">
                {description}
              </p>
            )}
          </div>
          <IconButton label={t("ui.closePanel")} onClick={onClose} className="-me-1 shrink-0">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-5 sm:px-6">
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-edge-subtle bg-surface-2 px-5 py-4 sm:px-6">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

/* ============================================================
   Page composition
   ============================================================ */

export function PageContainer({
  children,
  className = "",
  width = "default",
}: {
  children: React.ReactNode;
  className?: string;
  width?: "default" | "wide" | "narrow";
}) {
  const max =
    width === "wide" ? "max-w-[1680px]" : width === "narrow" ? "max-w-[960px]" : "max-w-[1440px]";
  return (
    <div className={`mx-auto w-full ${max} px-4 py-6 sm:px-6 sm:py-7 lg:px-8 lg:py-8 ${className}`}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  eyebrow,
  meta,
  icon,
  className = "",
  sticky = false,
  width = "default",
  variant = "band",
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: React.ReactNode;
  eyebrow?: React.ReactNode;
  meta?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  sticky?: boolean;
  width?: "default" | "wide" | "narrow";
  /**
   * "band"    — full-bleed page band with its own container + bottom border,
   *             used when the header sits directly under the app shell.
   * "inline"  — header block meant to live inside a `PageContainer`.
   */
  variant?: "band" | "inline";
}) {
  const max =
    width === "wide" ? "max-w-[1680px]" : width === "narrow" ? "max-w-[960px]" : "max-w-[1440px]";
  return (
    <header
      className={[
        variant === "band"
          ? `border-b border-edge-subtle ${sticky ? "sticky top-0 z-30 glass-chrome" : ""}`
          : "",
        className,
      ].join(" ")}
    >
      <div className={variant === "band" ? `mx-auto w-full ${max} px-4 py-5 sm:px-6 lg:px-8` : ""}>
        {breadcrumbs && <div className="mb-2 text-sm text-ink-3">{breadcrumbs}</div>}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-edge bg-surface text-ink-3 shadow-xs">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              {eyebrow && <div className="text-eyebrow mb-1.5">{eyebrow}</div>}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h1 className="text-2xl font-[640] leading-tight tracking-[-0.024em] text-ink sm:text-3xl">
                  {title}
                </h1>
                {meta}
              </div>
              {description && (
                <p className="mt-1.5 max-w-3xl text-base leading-relaxed text-ink-3">{description}</p>
              )}
            </div>
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
      </div>
    </header>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
  className = "",
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between ${className}`}>
      <div className="min-w-0">
        <h2 className="text-xl font-[600] tracking-[-0.014em] text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ============================================================
   Toast
   ============================================================ */

export function Toast({
  toast,
  onDismiss,
}: {
  toast: { text: string; type: "success" | "error" | "info" } | null;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!toast) return;
    if (toast.type === "error") return;
    timer.current = setTimeout(onDismiss, 5000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast, onDismiss]);
  if (!toast) return null;
  const tone: Tone = toast.type === "success" ? "ok" : toast.type === "error" ? "bad" : "info";
  return (
    <div
      role={toast.type === "error" ? "alert" : "status"}
      aria-live={toast.type === "error" ? "assertive" : "polite"}
      className={`pg-toast-in fixed bottom-5 end-5 z-[60] flex max-w-[420px] items-start gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur-xl ${toneBg[tone]}`}
    >
      {toast.type === "success" ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 break-words leading-relaxed">{toast.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("ui.dismissNotification")}
        className="-me-1 ms-auto shrink-0 rounded-xs p-1 text-current opacity-60 transition-colors duration-150 hover:bg-[var(--overlay-soft)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export { Check as CheckIcon };
