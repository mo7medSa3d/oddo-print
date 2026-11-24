/**
 * Product brand: supplied "Print Gateway" lockups (WP6-BRANDING).
 *
 * The artwork ships as files under `public/brand/` (Gateway) and as the
 * sanitized SVG/PNG/ICO icon set (Gateway favicon, Desktop icon, Tauri
 * bundle, Odoo Apps-list icon). The lockup text is baked into the artwork
 * as paths — there is no live text to translate — so the locale switch is
 * done with `dir`, not with JavaScript: the EN lockup shows under
 * `dir="ltr"` and the AR lockup under `dir="rtl"`. Both images stay in the
 * DOM and CSS hides the inactive one, which keeps this component usable
 * from server components (landing, pricing) that cannot read the client
 * locale store, and matches the pre-paint `lang`/`dir` script in
 * `src/app/layout.tsx` (no EN text ever renders on an Arabic page, and
 * vice versa). Aspect ratio is never overridden: lockups size by height
 * with `w-auto`.
 *
 * DARK SURFACES (v11-darklogo): the lockup wordmark is black-filled
 * artwork in the light files, so it would vanish on a dark header — and
 * the old fix (a white chip behind it in BOTH modes) is exactly what
 * looked wrong in dark mode: a glaring white block on a near-black
 * surface. There are now dedicated dark variants
 * (`public/brand/print-gateway-{en,ar}-dark.svg`) with the SAME layout,
 * proportions and icon, but white text (main line and subline both
 * #ffffff). BrandMark renders all four images and CSS in globals.css
 * shows exactly one pair, chosen by `[dir]` x `[data-theme]` — the
 * app's real theme mechanism (pre-paint script + ThemeToggle flip the
 * `data-theme` attribute on <html>, so the swap follows a live theme
 * toggle and stays server-component safe. The wrapper is now
 * clearspace only: `p-3` padding, NO background, NO ring, in either
 * mode, so no visible block ever appears behind the lockup. The
 * icon-only mark is a cyan tile with a light glyph and needs no chip.
 * CLEARSPACE (v10-exact, kept): the p-3 (12px) padding meets the
 * guide's >=1/4-mark rule even under the most conservative reading
 * (mark height = full lockup height: 48px -> 12px needed, 40px -> 10px,
 * 38px -> 9.5px).
 *
 * CALL-SITE COMPATIBILITY: `title`, `subtitle` and `variant` are kept in
 * the props so existing call sites need no edits, but they are NOT
 * rendered anymore — the lockup artwork supersedes the old "Yaseir /
 * Print Manager" wordmark (including the platform "Control Plane"
 * subline; the control-plane badge and aria labels elsewhere still carry
 * that distinction). Pass `showWordmark={false}` for the icon-only mark
 * (collapsed rails). `BrandMarkIcon` is the same icon as inline SVG so
 * it also works in the Desktop Vite/Tauri build, where an absolute
 * `/brand/...` URL would not resolve under the relative `base: "./"`.
 */

import { useId } from "react";

const LOCKUP_HEIGHT = {
  // Guide logo rule: full lockup starts at 120px wide. Artwork ratios:
  // EN 946.67/246 = 3.848, AR 813.44/245.33 = 3.316 (w-auto, never
  // stretched). Heights below would render under 120px in one language
  // (sm 30px -> EN 115 / AR 99; md 32px -> AR 106), so the sizes start
  // where BOTH languages clear 120px: 38px -> EN 146 / AR 126,
  // 40px -> EN 154 / AR 133, 48px -> EN 185 / AR 159.
  sm: "h-[38px]",
  md: "h-10",
  lg: "h-12",
} as const;

const ICON_BOX = {
  sm: "h-[30px] w-[30px]",
  md: "h-8 w-8",
  lg: "h-10 w-10",
} as const;

type BrandMarkProps = {
  size?: "sm" | "md" | "lg";
  showWordmark?: boolean;
  /** Legacy: kept for call-site compatibility, not rendered (see header). */
  title?: string;
  /** Legacy: kept for call-site compatibility, not rendered (see header). */
  subtitle?: string;
  className?: string;
  /** Legacy: kept for call-site compatibility; the lockup wrapper is
      transparent clearspace in both modes (no chip background). */
  variant?: "default" | "inverted" | "compact";
};

export function BrandMark({
  size = "md",
  showWordmark = true,
  className = "",
  title: _title,
  subtitle: _subtitle,
  variant: _variant,
}: BrandMarkProps) {
  if (!showWordmark) return <BrandMarkIcon size={size} className={className} />;
  const lockup = LOCKUP_HEIGHT[size];
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      {/* Narrow-header fallback: at <=399px the public header shows the
          icon only (see globals.css), matching the old wordmark rule. */}
      <BrandMarkIcon size={size} className="brand-mark-icon-fallback shrink-0" />
      {/* Clearspace wrapper only — transparent in both modes (see header:
          no bg-white chip). globals.css shows exactly one of the four
          lockups, by [dir] (en/ar) x [data-theme] (light/dark). */}
      <span className="brand-lockup-chip inline-flex shrink-0 items-center rounded-md p-3">
        {/* Plain <img>: shared with the Desktop Vite build, where
            next/image does not exist; Next does not optimize SVGs. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={`brand-lockup-ltr w-auto ${lockup}`}
          src="/brand/print-gateway-en.svg"
          alt="Print Gateway by Yaseir"
          draggable={false}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={`brand-lockup-rtl w-auto ${lockup}`}
          src="/brand/print-gateway-ar.svg"
          alt="بوابة الطباعة من يسير"
          draggable={false}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={`brand-lockup-ltr-dark w-auto ${lockup}`}
          src="/brand/print-gateway-en-dark.svg"
          alt="Print Gateway by Yaseir"
          draggable={false}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={`brand-lockup-rtl-dark w-auto ${lockup}`}
          src="/brand/print-gateway-ar-dark.svg"
          alt="بوابة الطباعة من يسير"
          draggable={false}
        />
      </span>
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
  const clipId = useId();
  return (
  <svg className={`${ICON_BOX[size]} ${className}`} viewBox="0 0 513 513" fill="none" role="img" aria-hidden="true">
    <defs>
      <clipPath id={clipId}>
        <path fill="none" d="M489.23,489.23c-155.16,31.03-310.31,31.03-465.45,0C-7.26,334.08-7.26,178.92,23.77,23.77c155.15-31.02,310.3-31.02,465.45,0,31.03,155.15,31.03,310.31,0,465.46Z"/>
      </clipPath>
    </defs>
    <g>
      <path fill="#00c7fc" d="M489.23,489.23c-155.16,31.03-310.31,31.03-465.45,0C-7.26,334.08-7.26,178.92,23.77,23.77c155.15-31.02,310.3-31.02,465.45,0,31.03,155.15,31.03,310.31,0,465.46Z"/>
      <g clipPath={`url(#${clipId})`}>
        <g>
          <path fill="#1dd4ff" d="M-100.84,327.54c-34.5-41.27-66.98-84.57-97.29-130.03,30.31-45.46,62.79-88.75,97.29-130.02,4.79-53.58,12.43-107.15,23.15-160.73,53.58-10.71,107.15-18.35,160.73-23.15,41.27-34.5,84.56-66.98,130.02-97.28,45.46,30.31,88.75,62.79,130.02,97.28,53.58,4.79,107.16,12.43,160.73,23.15,10.72,53.58,18.36,107.16,23.15,160.74,34.5,41.27,66.98,84.56,97.28,130.03-30.31,45.46-62.79,88.75-97.28,130.03-4.79,53.57-12.44,107.15-23.15,160.72-53.58,10.72-107.15,18.36-160.73,23.15-41.27,34.5-84.56,66.97-130.02,97.28-45.46-30.31-88.75-62.79-130.02-97.28-53.58-4.79-107.16-12.44-160.73-23.15-10.71-53.57-18.36-107.15-23.15-160.73Z"/>
          <path fill="#00c7fc" d="M-47.77,274.45c-26.5-31.7-51.45-64.95-74.73-99.87,23.28-34.92,48.23-68.17,74.73-99.87,3.68-41.15,9.55-82.3,17.78-123.45,41.15-8.23,82.3-14.1,123.45-17.78,31.7-26.5,64.95-51.44,99.86-74.72,34.92,23.28,68.17,48.23,99.87,74.72,41.15,3.68,82.3,9.55,123.46,17.78,8.23,41.15,14.1,82.31,17.78,123.46,26.5,31.7,51.44,64.95,74.72,99.87-23.28,34.92-48.23,68.17-74.72,99.87-3.68,41.15-9.55,82.3-17.78,123.45-41.15,8.23-82.3,14.1-123.45,17.78-31.7,26.5-64.95,51.44-99.87,74.72-34.92-23.28-68.16-48.23-99.86-74.72-41.15-3.68-82.3-9.55-123.46-17.78-8.23-41.15-14.1-82.3-17.78-123.45Z"/>
          <path fill="#1dd4ff" d="M-7,233.67c-20.35-24.35-39.52-49.89-57.4-76.71,17.88-26.82,37.04-52.36,57.4-76.71C-4.18,48.65.33,17.04,6.65-14.57c31.61-6.32,63.21-10.83,94.82-13.66,24.35-20.35,49.88-39.51,76.7-57.39,26.82,17.88,52.36,37.04,76.71,57.39,31.61,2.83,63.22,7.33,94.82,13.66,6.32,31.61,10.83,63.22,13.66,94.83,20.35,24.35,39.51,49.89,57.39,76.71-17.88,26.82-37.04,52.36-57.39,76.71-2.83,31.61-7.34,63.21-13.66,94.82-31.61,6.32-63.21,10.83-94.82,13.66-24.35,20.35-49.89,39.51-76.71,57.39-26.82-17.88-52.36-37.04-76.7-57.39-31.61-2.83-63.22-7.34-94.82-13.66-6.32-31.61-10.83-63.21-13.66-94.82Z"/>
          <path fill="#00bbf4" d="M-7,233.67c-20.35-24.35-39.52-49.89-57.4-76.71,17.88-26.82,37.04-52.36,57.4-76.71C-4.18,48.65.33,17.04,6.65-14.57c31.61-6.32,63.21-10.83,94.82-13.66,24.35-20.35,49.88-39.51,76.7-57.39,26.82,17.88,52.36,37.04,76.71,57.39,31.61,2.83,63.22,7.33,94.82,13.66,6.32,31.61,10.83,63.22,13.66,94.83,20.35,24.35,39.51,49.89,57.39,76.71-17.88,26.82-37.04,52.36-57.39,76.71-2.83,31.61-7.34,63.21-13.66,94.82-31.61,6.32-63.21,10.83-94.82,13.66-24.35,20.35-49.89,39.51-76.71,57.39-26.82-17.88-52.36-37.04-76.7-57.39-31.61-2.83-63.22-7.34-94.82-13.66-6.32-31.61-10.83-63.21-13.66-94.82Z"/>
          <path fill="#00b5ed" d="M24.31,202.35c-15.63-18.7-30.35-38.32-44.09-58.92,13.73-20.6,28.45-40.21,44.08-58.92,2.17-24.28,5.63-48.55,10.49-72.83C59.07,6.83,83.35,3.36,107.63,1.19c18.7-15.63,38.32-30.35,58.91-44.08,20.6,13.73,40.22,28.45,58.92,44.08,24.28,2.17,48.56,5.63,72.83,10.49,4.86,24.28,8.32,48.56,10.49,72.83,15.63,18.7,30.35,38.32,44.08,58.92-13.73,20.6-28.45,40.22-44.08,58.92-2.17,24.28-5.63,48.55-10.49,72.83-24.28,4.86-48.55,8.32-72.83,10.49-18.7,15.63-38.32,30.35-58.92,44.08-20.6-13.73-40.21-28.45-58.92-44.08-24.28-2.17-48.56-5.63-72.83-10.49-4.86-24.28-8.32-48.55-10.49-72.83Z"/>
          <path fill="#0ab0ea" d="M48.36,178.29c-12.01-14.36-23.31-29.43-33.86-45.26,10.55-15.82,21.85-30.89,33.86-45.25,1.67-18.65,4.33-37.29,8.06-55.94,18.65-3.73,37.29-6.39,55.94-8.06,14.36-12.01,29.43-23.31,45.25-33.86,15.82,10.55,30.89,21.85,45.25,33.86,18.65,1.67,37.29,4.33,55.94,8.06,3.73,18.65,6.39,37.3,8.06,55.94,12.01,14.36,23.31,29.43,33.86,45.25-10.55,15.82-21.85,30.89-33.86,45.25-1.67,18.65-4.33,37.29-8.06,55.94-18.65,3.73-37.29,6.39-55.94,8.06-14.36,12.01-29.43,23.31-45.25,33.86-15.82-10.55-30.89-21.85-45.25-33.86-18.65-1.67-37.29-4.33-55.94-8.06-3.73-18.65-6.39-37.29-8.06-55.94Z"/>
          <path fill="#17a7e0" d="M66.83,159.81c-9.22-11.03-17.91-22.61-26.01-34.76,8.1-12.15,16.79-23.72,26.01-34.76,1.28-14.32,3.32-28.64,6.19-42.97,14.32-2.86,28.64-4.91,42.97-6.19,11.03-9.22,22.6-17.9,34.76-26.01,12.15,8.1,23.73,16.78,34.76,26.01,14.32,1.28,28.65,3.32,42.97,6.19,2.86,14.32,4.91,28.65,6.19,42.97,9.22,11.03,17.9,22.61,26.01,34.76-8.1,12.15-16.78,23.73-26.01,34.76-1.28,14.32-3.32,28.64-6.19,42.97-14.32,2.86-28.64,4.91-42.97,6.19-11.03,9.22-22.61,17.9-34.76,26.01-12.15-8.1-23.72-16.78-34.76-26.01-14.32-1.28-28.65-3.32-42.97-6.19-2.86-14.32-4.91-28.64-6.19-42.97Z"/>
        </g>
      </g>
    </g>
    <path fill="#0953de" d="M179.16,133.93l-13.03,15.15c-.7,10.92-3.17,21.48-7.4,31.7l-18.32,44.74,2.47,1.05c27.48-35.93,53.89-57.41,89.82-57.41,56.01,0,82.78,51.43,62.35,90.53l-26.42,50.73c-40.86,15.5-88.06,20.78-130.33,20.78-15.15,0-30.65-2.11-43.68-8.46l-54.6-51.08v-7.04h76.09c5.99-9.16,11.98-17.97,17.61-26.07l-7.05-137.72,26.42-37.34h7.05l19.02,70.45ZM124.92,264.62h32.41c51.43,0,102.15-5.64,134.56-10.22-15.5-10.57-47.91-28.18-82.78-28.18-30.65,0-59.88,13.74-84.19,38.4Z"/>
  </svg>
  );
}
