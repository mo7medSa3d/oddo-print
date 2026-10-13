# Yaseir UI experience architecture

## Scope
Public landing, Gateway dashboard and Windows Agent desktop surfaces share
`src/app/globals.css` semantic tokens. Printing workflows, settings, credentials,
job state and existing deployment routes remain unchanged.

## Headless, styling and motion
- **Radix UI Dialog** is the shared accessible foundation for the refreshed
  marketing and Gateway mobile navigation: focus trap, Escape, overlay dismiss,
  ARIA title and return-to-trigger. The longer-lived legacy common overlays
  are not migrated in this batch to avoid regressing printing dialogs.
- **Park UI patterns:** use `--surface`, `--border`, `--brand`, `--text`,
  semantic status tones and shared radii/shadows; no duplicate palettes.
- **React Bits-inspired SpotlightSurface** is a zero-state pointer-follow
  highlight used only in decorative public cards. Keyboard users get the same
  contrast through `:focus-within`; it never changes the card geometry.
- **GSAP:** code-split to the marketing route, with a `gsap.context()` scope,
  context-reverted unmount, one-shot ScrollTriggers and an explicit reduced-motion
  bypass. Content is server-rendered and functional even if JS/motion fails.
- **Lenis:** intentionally not installed. Native scrolling is more predictable
  for Gateway data tables, route navigation, Windows WebView, and touch devices.
  If added to a genuinely scroll-driven future presentation, it must use
  `gsap.ticker.add`, update ScrollTrigger, and disable touch interception.

## Acceptance
Run TypeScript, lint, i18n, Vite desktop build, Next.js build, a11y smoke and
keyboard tests in GitHub Actions. Check Arabic RTL and English LTR at 320/390px,
tablet and desktop widths in both themes; ensure no overflow, clipped mobile
dialogs, or focus loss. Preserve no-hardware acceptance semantics; visuals do
not represent live printer telemetry on the public landing.
