# Yaseir — Frontend UI/UX Audit (pre-overhaul snapshot)

Date: 2026-10-01 · Scope: `src/app` (Next.js console, platform control plane, auth,
marketing), `src/components`, `src/desktop` (Tauri Manager).

## 1. Architecture (as found)

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 App Router, React 19, custom Node entrypoint (`server.ts`) |
| Styling | Tailwind CSS v4 (CSS-first `@theme` in `src/app/globals.css`) |
| Icons | `lucide-react` (single family — good) |
| Primitives | One hand-rolled module: `src/components/ui.tsx` (1123 lines, 24 exports) |
| Theme | `data-theme` on `<html>`, pre-paint script, light/dark tokens |
| Motion | 4 keyframes (`pg-fade-in`, `pg-rise-in`, `pg-scale-in`, `pg-slide-in-right`), shimmer skeleton |
| Desktop app | Separate Vite + React app in `src/desktop` with its own `ui.tsx` + `theme-light.css` |

## 2. Routes / screens inventoried

Console: `/dashboard` (1,445-line client), `/api-keys`, `/team`, `/billing`, `/settings`,
`/system-health`, `/release-readiness`.
Platform: `/platform/login`, `/platform/dashboard`, `/platform/tenants`,
`/platform/subscriptions`, `/platform/plans`, `/platform/audit`.
Auth / onboarding: `/login`, `/signup`, `/verify-email`, `/forgot-password`,
`/reset-password`, `/invite`, `/onboarding`.
Marketing: `/`, `/pricing`. Shell states: `error.tsx`, `not-found.tsx`, `loading.tsx`.

## 3. Findings

### 3.1 Typography
- 26 distinct arbitrary font sizes (`13px` ×177, `11px` ×143, `12px` ×80, `10px` ×43,
  `12.5px` ×26 … ). No named type scale, no role classes.
- Page titles ranged 22–30px with three different tracking values; card titles ranged
  14–17px. Section hierarchy is inconsistent between console and platform.
- No numeric/statistic typography standard (some `tabular-nums`, some not).

### 3.2 Spacing & layout
- Each page hand-rolled its own container (`max-w-[1200px]`, `[1440px]`, `[1800px]`),
  own header markup, own vertical rhythm (`space-y-6` vs `space-y-7` vs `gap-6`).
- No shared page-header / section primitive in practice (`PageHeader` existed but was
  unused — every page re-implemented it).
- Card padding varied: `p-4`, `p-5`, `p-6`, `px-5 pb-5`, `px-6 pb-6`.

### 3.3 Color & surfaces
- Token system existed but was bypassed: `text-white` on brand buttons, `bg-ink text-white`
  badges (`AgentHealthMatrix`), inline `rgba()` shadows (`TopNavbar`), duplicated
  success/warning/info pill markup with slightly different paddings.
- Three near-identical "card" classes (`card`, `card-elevated`, `balance-card`) plus
  `billing-premium` and `inset-panel`, each with its own radius/shadow pairing.

### 3.4 Radius & elevation
- 14 distinct radii in use: `4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16` + `2xl`, `xl`, `lg`.
- Shadows were single-layer and inconsistent (`shadow-card`, `shadow-md`, `shadow-lg`,
  plus one-offs).

### 3.5 Interaction & controls
- Button heights: `h-8`, `h-9`, `h-10`, `h-11` mixed inside the same toolbar; inputs
  `h-11` vs `h-9` in the same card. No icon-button size system.
- No dropdown/menu primitive — row actions were rendered as inline buttons.
- No tooltip, no command surface, no toast region (a single page-local `Toast` existed).
- Selected/active/hover states varied between `bg-brand text-white`,
  `bg-brand-subtle text-brand-subtle-text`, and `bg-ink text-white`.

### 3.6 States
- Loading: bare text (“Loading jobs…”, “Loading…”) next to skeletons, mixed metaphors.
- Empty: short dead-ends (“No printers match. Check agent connectivity.”) with no action.
- Error: three different treatments (inline red box, centered icon panel, `role="alert"`
  strip) for the same failure class.
- No first-use/onboarding state for the console; no offline/disconnected shell banner.

### 3.7 Navigation
- Single horizontal top bar for 5 console items + platform control plane; no grouping,
  no workspace identity, no account menu, no collapse; mobile menu rendered as an
  absolutely positioned dropdown over the page.
- Active state uses an inset ring; hover/active/focus tokens differed from sidebar
  conventions used in the desktop app.

### 3.8 Accessibility
- Good baseline (focus-visible outline, modal inert + focus trap, field wiring is
  tested). Gaps: icon-only buttons sometimes lack labels, tab strips had no
  `role="tablist"` in page-local implementations, `text-ink-4` used for body copy in
  several places (sub-AA contrast), decorative pulse animations ran continuously
  without a `prefers-reduced-motion` guard per component.

### 3.9 Responsiveness
- Charts/`min-w` values caused horizontal overflow risks under 360px; tables relied on
  raw `overflow-x-auto` with no column priority; the dashboard grid collapsed to
  single column at `lg` but kept 8/4 spans' internal padding.

### 3.10 Performance
- No animation library (good). Cost centres: large single client component
  (`dashboard-client.tsx`), repeated inline object/array literals in render, and
  every dialog mounting its own scroll-lock/portal machinery (already optimised).

## 4. Overhaul plan (executed after this audit)

1. Rebuild the token layer in `globals.css`: one type scale, one spacing rhythm, one
   radius scale, layered elevation, semantic status colors, motion tokens, and a
   `dark:` variant bound to `data-theme`.
2. Rebuild `src/components/ui.tsx` into a coherent primitive kit (Button, Field set,
   Status, Card/Surface, Table, Menu, Tooltip, Tabs/Segmented, States, Dialog/Drawer)
   without changing any exported contract used by tests or pages.
3. Replace the top-bar-only shell with an app shell: collapsible console sidebar with
   workspace identity + account controls, mobile sheet navigation, command surface,
   and a platform top bar for the control plane.
4. Redesign every screen against the new hierarchy rules (dashboard, agents, printers,
   jobs, billing, team, API keys, settings, platform pages, auth, onboarding, states).
5. Verify: typecheck, lint, unit/integration tests, production build, responsive +
   reduced-motion + keyboard passes.

## 5. Outcome (implemented)

### 5.1 Design system
- `src/app/globals.css` is the single theme source for web **and** desktop: one type scale
  (`text-2xs` … `text-5xl`), one radius scale (`--r-xs` … `--r-3xl` + control/card/panel
  aliases), semantic status colours (`--success/warning/danger/info` + solid variants),
  layered elevation (`--shadow-xs/card/card-hover/pop/overlay`), motion tokens
  (`--dur-fast/normal/slow`, `--ease-out/spring`), and `@custom-variant dark` bound to
  `data-theme` (never `prefers-color-scheme` at the utility level).
- Zero raw palette utilities remain in product surfaces: `text-white` → `text-brand-contrast`
  / `text-on-solid`, arbitrary `text-[NNpx]` → scale roles, arbitrary `rounded-[NNpx]` →
  radius tokens, `bg-black/10` → `--overlay-soft`. Verified by grep across `src/**`.
- Every keyframe is `motion-safe` and gated by a global `prefers-reduced-motion` block.

### 5.2 Primitives (`src/components/ui.tsx`)
One kit, no duplicates: `Button`/`IconButton` (6 variants × 3 sizes, link-capable,
`type="button"` by default), `Field`+`Input/Textarea/Select/Checkbox` (labels + hints +
`aria-describedby`/`aria-invalid` wiring), `Card/CardHeader/Section/Panel`, `DataTableShell/
TableScroll/TableSkeleton`, `StatusBadge/StatusDot` (tone + **label**, never colour alone),
`EmptyState/ErrorState/Callout/LoadingState/Skeleton/PageSkeleton`, `Menu/Tooltip/Tabs/
SegmentedControl`, `Modal/Drawer/ConfirmDialog` (shared scroll-lock + focus trap), `Toast`,
`PageHeader` (band or inline variant) + `PageContainer` (3 widths), `StatCard`, `MetaRow`/
`KeyValueList`, `CopyButton`, `Kbd`, `Avatar`.

### 5.3 Shells & screens
- Console: collapsible sidebar (grouped nav, persisted preference, mobile sheet, ⌘K command
  palette, workspace identity menu) via `AppShell`; platform control plane keeps the
  horizontal `TopNavbar`.
- Redesigned screens: dashboard (fleet summary, agents, printers grid/table, certification,
  jobs table + inspector timeline), billing, team, API keys, settings, system health,
  release readiness, platform dashboard/subscriptions/tenants/audit/plans, the full auth set,
  onboarding, marketing home, pricing, and the `error`/`not-found`/`loading` boundaries.
- Shared vocabulary: job/printer status labels, tones and guidance all flow from
  `src/shared/job-vocabulary.ts`, so the dashboard, tables, badges and timelines agree.

### 5.4 Verification (all green)
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (0 errors; the new shell/chart/dialog components were refactored off
  `react-hooks/set-state-in-effect` instead of being suppressed).
- `npx vitest run --config vitest.unit.config.mts` — **91 files / 685 passed / 1 skipped, 0 failed**
  (the previously skipped HTTP acceptance file now executes against the production build and passes).
- `next build --webpack` — compiled successfully, 55 routes generated.
- `npm run desktop:vite:build` — desktop Manager bundles unchanged.
- Public pages server-render with real content (`/`, `/pricing`, `/login`, `/signup`,
  `/forgot-password`, `/onboarding`, `/platform/login`, 404 boundary).
