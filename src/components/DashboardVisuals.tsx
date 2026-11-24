import type { ReactNode } from "react";

/**
 * Minimal, theme-aware SVG visuals for the Yaseir Licensing Gateway overview.
 * Built on semantic CSS tokens for Light/Dark parity and RTL/LTR clarity.
 */

export function DirectPrintHeroSvg({ active }: { active: boolean }) {
  const accent = active ? "var(--success-solid)" : "var(--warning-solid)";
  return (
    <svg
      viewBox="0 0 360 148"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="h-auto w-full max-w-[340px] select-none"
    >
      <defs>
        <linearGradient id="yaseir-ios-bg" x1="0" y1="0" x2="360" y2="148" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.08" />
          <stop offset="100%" stopColor={accent} stopOpacity="0.08" />
        </linearGradient>
        <linearGradient id="yaseir-ios-line" x1="88" y1="74" x2="272" y2="74" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor={accent} />
        </linearGradient>
      </defs>

      <rect
        x="1"
        y="1"
        width="358"
        height="146"
        rx="20"
        fill="url(#yaseir-ios-bg)"
        stroke="var(--border)"
        strokeWidth="1"
      />

      {/* Direct connection hairlines */}
      <path d="M98 74 H146" stroke="url(#yaseir-ios-line)" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 4" />
      <path d="M214 74 H262" stroke="url(#yaseir-ios-line)" strokeWidth="2" strokeLinecap="round" />

      {/* Odoo Node */}
      <rect x="26" y="44" width="72" height="60" rx="16" fill="var(--surface)" stroke="var(--border)" strokeWidth="1" />
      <circle cx="44" cy="64" r="4" fill="var(--brand)" />
      <rect x="54" y="61" width="28" height="6" rx="3" fill="currentColor" opacity="0.65" />
      <rect x="40" y="78" width="44" height="5" rx="2.5" fill="currentColor" opacity="0.2" />

      {/* Center License Shield Node */}
      <rect x="146" y="38" width="68" height="72" rx="20" fill="var(--surface)" stroke="var(--brand)" strokeWidth="1.5" />
      <circle cx="180" cy="68" r="16" fill="var(--brand)" fillOpacity="0.1" />
      <path
        d="M180 57 L190 61.5 V68.5 C190 74.2 185.7 78.8 180 80.5 C174.3 78.8 170 74.2 170 68.5 V61.5 L180 57 Z"
        stroke="var(--brand)"
        strokeWidth="1.8"
        fill="var(--brand)"
        fillOpacity="0.12"
        strokeLinejoin="round"
      />
      <path
        d="M176 68.8 L178.8 71.6 L184.2 66.2"
        stroke="var(--brand)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="180" cy="96" r="3" fill={accent} />

      {/* Local Printer Node */}
      <rect x="262" y="44" width="72" height="60" rx="16" fill="var(--surface)" stroke="var(--border)" strokeWidth="1" />
      <rect x="284" y="56" width="28" height="10" rx="3" fill="currentColor" opacity="0.12" />
      <rect x="278" y="64" width="40" height="18" rx="5" fill="var(--surface-2)" stroke="var(--border-strong)" strokeWidth="1" />
      <circle cx="310" cy="71" r="2.2" fill={accent} />
      <rect x="285" y="78" width="26" height="14" rx="2.5" fill="var(--surface)" stroke="var(--border)" strokeWidth="1" />
    </svg>
  );
}

export function LicenseShieldSvg() {
  return (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="h-9 w-9 shrink-0">
      <rect x="0.5" y="0.5" width="39" height="39" rx="12" fill="var(--brand-subtle)" stroke="var(--border-accent)" />
      <path
        d="M20 10 L28 13.5 V19.5 C28 24.5 24.5 28.5 20 30 C15.5 28.5 12 24.5 12 19.5 V13.5 L20 10 Z"
        stroke="var(--brand)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M16.8 20.2 L19 22.4 L23.5 17.8" stroke="var(--brand)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DirectTopologySvg() {
  return (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="h-9 w-9 shrink-0">
      <rect x="0.5" y="0.5" width="39" height="39" rx="12" fill="var(--brand-subtle)" stroke="var(--border-accent)" />
      <circle cx="13" cy="20" r="3" fill="var(--brand)" />
      <circle cx="27" cy="20" r="3" fill="var(--success-solid)" />
      <path d="M16.5 20 H23.5" stroke="var(--brand)" strokeWidth="1.7" strokeLinecap="round" strokeDasharray="2.5 2.5" />
    </svg>
  );
}

export function ZeroCloudRelaySvg() {
  return (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="h-9 w-9 shrink-0">
      <rect x="0.5" y="0.5" width="39" height="39" rx="12" fill="var(--brand-subtle)" stroke="var(--border-accent)" />
      <rect x="11" y="13" width="18" height="14" rx="4" stroke="var(--brand)" strokeWidth="1.6" strokeDasharray="3 2" />
      <circle cx="20" cy="20" r="3" fill="var(--brand)" />
    </svg>
  );
}

export function VisualArchitectureCard({
  illustration,
  title,
  description,
  badge,
}: {
  illustration: ReactNode;
  title: string;
  description: string;
  badge: string;
}) {
  return (
    <div className="glass-card flex h-full flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-3">
        {illustration}
        <span className="rounded-full border border-edge-subtle bg-surface-2/80 px-2.5 py-0.5 text-2xs font-medium text-ink-3">
          {badge}
        </span>
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">{description}</p>
      </div>
    </div>
  );
}
