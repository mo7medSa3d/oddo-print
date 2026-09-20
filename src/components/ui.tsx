"use client";

import React, { useEffect, useId, useRef } from "react";
import Link from "next/link";
import { X, Check, Loader2, Copy, AlertTriangle, ChevronDown } from "lucide-react";

/* ============================================================
   YASSER — Premium SaaS UI Primitives 2026
   One source for Button / Badge / Status / Card / Empty &
   error states / Modal / Drawer / Field.
   Used by Gateway (Next), Platform Admin, and Desktop (Vite)
   so all surfaces stay visually coherent.
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

const toneDot: Record<Tone, string> = {
  ok: "bg-ok-solid",
  warn: "bg-warn-solid",
  bad: "bg-bad-solid",
  info: "bg-info-solid",
  neutral: "bg-ink-4",
  brand: "bg-brand",
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

/* ---------- Buttons — premium, restrained ---------- */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-white border border-transparent shadow-[0_1px_2px_rgba(37,99,235,0.18)] hover:bg-brand-hover hover:shadow-[0_2px_6px_rgba(37,99,235,0.22)] active:bg-brand-active active:shadow-none",
  secondary:
    "bg-surface text-ink border border-edge shadow-xs hover:bg-surface-2 hover:border-edge-strong hover:shadow-sm active:bg-surface-3",
  ghost:
    "bg-transparent text-ink-2 border border-transparent hover:bg-surface-2 hover:text-ink active:bg-surface-3",
  danger:
    "bg-bad-solid text-white border border-transparent shadow-xs hover:bg-[#be123c] active:bg-[#9f1239]",
  success:
    "bg-ok-solid text-white border border-transparent shadow-xs hover:brightness-[0.96] active:brightness-[0.92]",
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
  const sizes =
    size === "sm"
      ? "h-9 px-3 text-[13px] gap-1.5 rounded-[8px]"
      : size === "lg"
        ? "h-11 px-5 text-[14px] gap-2.5 rounded-[10px]"
        : "h-10 px-4 text-[13.5px] gap-2 rounded-[9px]";

  const baseClasses = `inline-flex items-center justify-center font-[600] tracking-[-0.01em] transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20 focus-visible:border-brand ${buttonVariants[variant]} ${sizes} ${className}`;

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
        className={`${baseClasses} ${linkDisabled ? "pointer-events-none opacity-50" : ""}`}
        aria-disabled={linkDisabled || undefined}
        aria-busy={loading || undefined}
        tabIndex={linkDisabled ? -1 : props.tabIndex}
        onClick={handleLinkClick}
        title={props.title}
        id={props.id}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
        {children}
      </Link>
    );
  }

  return (
    <button className={baseClasses} disabled={loading || disabled} {...props}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
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
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center h-9 w-9 rounded-[9px] text-ink-3 transition-all duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20 disabled:opacity-50 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/* ---------- Status ---------- */

export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 rounded-full ${toneDot[tone]} ${pulse ? "animate-pulse" : ""}`}
    />
  );
}

export function StatusBadge({
  tone = "neutral",
  label,
  icon,
  pulse,
  className = "",
}: {
  tone?: Tone;
  label: string;
  icon?: React.ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  const shouldPulse = pulse ?? (tone === "info");
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold tracking-wide whitespace-nowrap ${toneBg[tone]} ${className}`}
    >
      {icon ?? <StatusDot tone={tone} pulse={shouldPulse} />}
      {label}
    </span>
  );
}

/* ---------- Surface ---------- */

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function StatCard({
  title,
  value,
  subtitle,
  icon,
  tone = "neutral",
  trend,
  className = "",
}: {
  title: string;
  value: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: Tone;
  trend?: { text: string; positive?: boolean };
  className?: string;
}) {
  return (
    <div
      className={`group relative overflow-hidden rounded-[14px] border border-edge bg-surface p-5 shadow-card transition-all duration-200 hover:shadow-card-hover hover:border-edge-strong hover:-translate-y-[1px] ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">{title}</span>
        {icon && (
          <div
            className={`flex h-9 w-9 items-center justify-center rounded-[10px] border ${toneBg[tone]} shadow-xs`}
          >
            {icon}
          </div>
        )}
      </div>
      <div className="mt-4">
        <div className="text-[28px] font-bold tracking-[-0.02em] leading-none text-ink tabular-nums">
          {value}
        </div>
        {(subtitle || trend) && (
          <div className="mt-2.5 flex items-center gap-2 text-[12px] leading-snug text-ink-3">
            {trend && (
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  trend.positive ? "bg-ok-bg text-ok border border-ok-edge" : "bg-bad-bg text-bad border border-bad-edge"
                }`}
              >
                {trend.text}
              </span>
            )}
            {subtitle && <span className="truncate">{subtitle}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  icon,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2.5 text-[15px] font-semibold leading-tight tracking-[-0.01em] text-ink">
          {icon}
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-[13px] leading-snug text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/* ---------- Premium financial cards ---------- */

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
  return (
    <div className="billing-premium p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-edge-accent bg-brand-subtle px-2.5 py-1 text-[11px] font-semibold tracking-wide text-brand-subtle-text">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            PLAN
          </div>
          <div className="mt-3 text-[22px] font-bold tracking-tight text-ink">{plan}</div>
          {status && <div className="mt-1 text-[13px] text-ink-3">{status}</div>}
        </div>
        {balance && (
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Balance</div>
            <div className="mt-1 text-financial-lg text-ink tabular-nums">{balance}</div>
          </div>
        )}
      </div>

      {typeof usagePercent === "number" && (
        <div className="mt-6">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-ink-3">Usage</span>
            <span className="font-semibold text-ink tabular-nums">{usagePercent}% used</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-brand transition-all duration-500"
              style={{ width: `${Math.min(100, Math.max(0, usagePercent))}%` }}
            />
          </div>
        </div>
      )}

      {entitlements && entitlements.length > 0 && (
        <div className="mt-5 grid grid-cols-3 gap-2">
          {entitlements.slice(0, 6).map((e) => (
            <div key={e.label} className="rounded-[10px] border border-edge bg-surface-2 px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">{e.label}</div>
              <div className="mt-0.5 text-[13px] font-semibold text-ink tabular-nums">{e.value}</div>
            </div>
          ))}
        </div>
      )}

      {renewal && <div className="mt-5 text-[12px] text-ink-3">Renews on {renewal}</div>}

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
  return (
    <div className="balance-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Current balance</div>
          <div className="mt-2 text-[34px] font-bold tracking-[-0.03em] leading-none text-ink tabular-nums">{amount}</div>
          {subtitle && <div className="mt-2 text-[13px] text-ink-3">{subtitle}</div>}
        </div>
        {trend && (
          <div className="rounded-full bg-ok-bg border border-ok-edge px-2.5 py-1 text-[11px] font-semibold text-ok">
            {trend}
          </div>
        )}
      </div>
      {actions && <div className="mt-5 flex gap-2">{actions}</div>}
      {footer && <div className="mt-5 border-t border-edge pt-4 text-[12px] text-ink-3">{footer}</div>}
    </div>
  );
}

/* ---------- States ---------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center px-8 py-14 sm:py-16 ${className}`}
    >
      <div className="flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-[14px] border border-edge-accent bg-surface-accent text-brand shadow-xs">
        {icon}
      </div>
      <h3 className="mt-4 text-[16px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>
      {description && (
        <p className="mt-2 max-w-[36ch] text-[13.5px] leading-relaxed text-ink-3">{description}</p>
      )}
      {action && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">{action}</div>
      )}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  retry,
  className = "",
}: {
  title?: string;
  message: string;
  retry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex flex-col items-start gap-3 rounded-xl border border-bad-edge bg-bad-bg px-4 py-3.5 text-sm sm:flex-row sm:items-start ${className}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-bad" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-bad">{title}</div>
        <p className="mt-1 break-words leading-relaxed text-[13px] text-ink-2">{message}</p>
      </div>
      {retry && (
        <Button size="sm" variant="secondary" onClick={retry} className="shrink-0">
          Retry
        </Button>
      )}
    </div>
  );
}

export function LoadingState({
  rows = 3,
  className = "",
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-label="Loading" className={`space-y-3 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-8" style={{ width: `${100 - (i % 3) * 14}%` }} />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function PageSkeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`space-y-6 ${className}`}>
      <div className="space-y-3">
        <div className="skeleton h-7 w-48" />
        <div className="skeleton h-4 w-80" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
      </div>
      <div className="skeleton h-[320px] rounded-[14px]" />
    </div>
  );
}

/* ---------- Forms ---------- */

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
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
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
        <label htmlFor={controlId} className="block text-[12.5px] font-semibold tracking-[-0.01em] text-ink">
          {label}
        </label>
        <div className="mt-1.5">{children}</div>
        {error && (
          <p id={descriptionId} className="mt-1.5 text-[12.5px] font-medium text-bad">
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={descriptionId} className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">
            {hint}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

export const inputClass =
  "w-full h-10 rounded-[9px] border border-edge bg-surface px-3.5 text-[13.5px] text-ink placeholder:text-ink-4 shadow-xs transition-all duration-150 hover:border-edge-strong focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 disabled:opacity-50 disabled:bg-surface-2";

export function Input({
  className = "",
  error,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { error?: boolean }) {
  const field = React.useContext(FieldContext);
  const invalid = error ?? field?.invalid ?? false;

  return (
    <input
      id={id ?? field?.controlId}
      aria-invalid={ariaInvalid ?? (invalid || undefined)}
      aria-describedby={ariaDescribedBy ?? field?.descriptionId}
      className={`${inputClass} ${
        invalid ? "border-bad-edge focus:border-bad focus:ring-bad/15" : ""
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
  const field = React.useContext(FieldContext);
  const invalid = error ?? field?.invalid ?? false;

  return (
    <span className={`relative inline-flex items-center [&>svg]:pointer-events-none ${className}`}>
      <select
        id={id ?? field?.controlId}
        aria-invalid={ariaInvalid ?? (invalid || undefined)}
        aria-describedby={ariaDescribedBy ?? field?.descriptionId}
        className={`${inputClass} w-full appearance-none pr-8 ${
          invalid ? "border-bad-edge focus:border-bad focus:ring-bad/15" : ""
        }`}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="absolute right-2.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
    </span>
  );
}

/* ---------- Modal / Drawer — premium ---------- */

const inertedBackground = new Set<HTMLElement>();
let openDialogCount = 0;

function refreshBackgroundIsolation(): void {
  if (typeof document === "undefined") return;
  if (openDialogCount === 0) {
    inertedBackground.forEach((el) => {
      el.inert = false;
    });
    inertedBackground.clear();
    return;
  }
  document.querySelectorAll<HTMLElement>("[data-dialog-root]").forEach((root) => {
    let el: HTMLElement | null = root;
    while (el && el !== document.body) {
      const parent: HTMLElement | null = el.parentElement;
      if (!parent) break;
      [...parent.children].forEach((sib) => {
        if (
          sib instanceof HTMLElement &&
          sib !== el &&
          !sib.contains(el) &&
          !sib.hasAttribute("data-dialog-root") &&
          sib.querySelector("[data-dialog-root]") === null &&
          !inertedBackground.has(sib)
        ) {
          sib.inert = true;
          inertedBackground.add(sib);
        }
      });
      el = parent;
    }
  });
}

function useDialog(
  open: boolean,
  onClose: () => void,
  panelRef: React.RefObject<HTMLDivElement | null>
) {
  useEffect(() => {
    if (!open) return;
    openDialogCount += 1;
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
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
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
      if (e.shiftKey && document.activeElement === first) {
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
      openDialogCount = Math.max(0, openDialogCount - 1);
      refreshBackgroundIsolation();
      prev?.focus?.();
    };
  }, [open, onClose, panelRef]);
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
  const panelRef = useRef<HTMLDivElement>(null);
  const descId = useId();
  useDialog(open, onClose, panelRef);
  if (!open) return null;
  return (
    <div data-dialog-root className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="pg-fade-in absolute inset-0 backdrop-blur-[2px]"
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
        className={`pg-scale-in relative w-full ${
          wide ? "sm:max-w-2xl" : "sm:max-w-[480px]"
        } max-h-[90vh] overflow-auto rounded-t-[16px] sm:rounded-[16px] border border-edge bg-surface shadow-2xl outline-none`}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-edge bg-surface px-6 py-5">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
            {description && (
              <p id={descId} className="mt-1 text-[13px] leading-snug text-ink-3">
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close dialog" onClick={onClose} className="-mr-1">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && (
          <div className="sticky bottom-0 flex justify-end gap-2 border-t border-edge bg-surface-2/80 px-6 py-4 backdrop-blur-sm">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const descId = useId();
  useDialog(open, onClose, panelRef);
  if (!open) return null;
  return (
    <div data-dialog-root className="fixed inset-0 z-50 flex justify-end">
      <div
        className="pg-fade-in absolute inset-0 backdrop-blur-[1px]"
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
        className="pg-slide-in-right relative flex h-full w-full max-w-[480px] flex-col border-l border-edge bg-surface shadow-2xl outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-edge px-6 py-5">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
            {description && (
              <p id={descId} className="mt-1 truncate text-[13px] text-ink-3">
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close panel" onClick={onClose} className="-mr-1">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Tabs ---------- */

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  counts,
  className = "",
}: {
  tabs: readonly T[];
  active: T;
  onChange: (t: T) => void;
  counts?: Partial<Record<T, number>>;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const idx = tabs.indexOf(active);
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
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
      aria-label="Filter options"
      onKeyDown={onListKeyDown}
      className={`flex items-center gap-0.5 overflow-x-auto border-b border-edge ${className}`}
    >
      {tabs.map((t) => {
        const selected = t === active;
        const count = counts?.[t];
        return (
          <button
            key={t}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-tab={t}
            onClick={() => onChange(t)}
            className={`relative flex items-center gap-2 whitespace-nowrap px-3.5 py-2.5 text-[13px] font-[600] tracking-[-0.01em] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20 rounded-[8px] ${
              selected ? "text-ink bg-surface-2" : "text-ink-3 hover:text-ink hover:bg-surface-2"
            }`}
          >
            <span className="capitalize">{t}</span>
            {count !== undefined && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                  selected ? "bg-brand-subtle text-brand-subtle-text" : "bg-surface-3 text-ink-3"
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

/* ---------- Misc ---------- */

export function CopyButton({
  value,
  onCopied,
  label = "Copy",
  className = "",
}: {
  value: string;
  onCopied?: () => void;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          onCopied?.();
          setTimeout(() => setCopied(false), 2000);
        } catch {}
      }}
      className={`inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-edge bg-surface px-2.5 text-[12px] font-medium text-ink-2 transition-all duration-150 hover:border-edge-accent hover:bg-brand-subtle hover:text-brand-subtle-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20 ${className}`}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 text-ok" aria-hidden />
          <span className="text-ok">Copied</span>
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" aria-hidden />
          {label}
        </>
      )}
    </button>
  );
}

export function Toast({
  toast,
  onDismiss,
}: {
  toast: { text: string; type: "success" | "error" | "info" } | null;
  onDismiss: () => void;
}) {
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
  const tone = toast.type === "success" ? "ok" : toast.type === "error" ? "bad" : "info";
  return (
    <div
      role="status"
      className={`pg-toast-in fixed bottom-6 right-6 z-[60] flex max-w-md items-start gap-3 rounded-[12px] border px-4 py-3.5 text-[13px] shadow-xl backdrop-blur-sm ${toneBg[tone]}`}
    >
      {toast.type === "success" ? (
        <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-ok" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 break-words leading-snug">{toast.text}</span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="ml-auto flex-shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Mono({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <code className={`font-mono text-[11.5px] tracking-[-0.01em] text-ink-2 ${className}`}>{children}</code>;
}

export function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-2.5 text-sm">
      <span className="shrink-0 text-[12.5px] text-ink-3">{label}</span>
      <span className="min-w-0 text-right text-[13px] font-semibold text-ink">{children}</span>
    </div>
  );
}

/* ---------- New premium components ---------- */

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  className = "",
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`border-b border-edge bg-surface ${className}`}>
      <div className="mx-auto max-w-[1440px] px-6 py-6 sm:px-8">
        {breadcrumbs && <div className="mb-3 text-[12px] text-ink-3">{breadcrumbs}</div>}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-[22px] font-bold tracking-[-0.02em] leading-tight text-ink">{title}</h1>
            {description && (
              <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-ink-3">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2.5">{actions}</div>}
        </div>
      </div>
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card overflow-hidden ${className}`}>
      {(title || description || actions) && (
        <div className="flex items-start justify-between gap-4 border-b border-edge px-6 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-ink-3">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
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
    <div className={`overflow-hidden rounded-[14px] border border-edge bg-surface shadow-card ${className}`}>
      {children}
    </div>
  );
}
