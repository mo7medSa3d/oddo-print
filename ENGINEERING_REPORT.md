# Engineering Report — Premium SaaS 2026 UI/UX Transformation

Date: 2026-09-20
Branch: arena/01a0c076-oddo-print
Base: de64374afd031b083a7555369a44e4cf7f622e0c (main)

## 1. Objective
Full production UI/UX transformation per MASTER PROTOCOL:
- Modern premium SaaS 2026 aesthetic across Desktop Manager (Tauri), Gateway SaaS web, Platform Admin, Odoo Print Gateway config UI
- Unified design system, preserve all business logic, API contracts, auth, RBAC, tenant isolation, billing, queue/job lifecycle, Tauri IPC, Go agent

## 2. Design System Unified

### Tokens (light premium)
- Brand: #2563eb (Signal Blue), hover #1d4ed8, active #1e40af, subtle #eff6ff
- BG: #f8fafc, Surface: #ffffff, Border: #e2e8f0 / #cbd5e1, Text: #0f172a / #475569 / #64748b
- Radius: 8/10/12/14/16 pill 9999, Shadow: xs/sm/md/lg/xl + shadow-card 0 1px 3px + 0 8px 24px + shadow-brand
- Typography: Inter, tracking -0.02em to -0.03em for headings, tabular-nums for financial
- Dark control plane (Platform Admin): #080a12 header, #0c0e1a sidebar, #12141f cards, border white/[0.06], text slate-100/400/500

### Components (src/components/ui.tsx + src/desktop/ui.tsx)
- Button: h-10 rounded 10px, primary brand shadow 18%, secondary surface border edge, ghost, danger, success. Sizes sm h-9, lg h-11. Focus ring brand/20.
- Badge: rounded-full 11.5px semibold, toneBg ok/warn/bad/info/neutral/brand with dot pulse.
- Card: rounded 14px border edge bg-surface shadow-card, hover -1px shadow-lg border-strong. billing-premium with 2px gradient hairline top.
- StatCard: top 2px gradient accent line per tone, icon chip 8x8 rounded 10px, tabular-nums 22-28px.
- Modal/Drawer: backdrop blur 2px overlay 48%, rounded 16px, header sticky 64px border, scale-in / slide-in-right animations, focus trap with inert background isolation, ESC handling.
- Input: h-10 rounded 9px border edge bg-surface, ring brand/15 focus, invalid bad-edge.
- Tabs: rounded 8px, active bg-surface-2 text-ink, count pill brand-subtle.
- EmptyState/ErrorState/LoadingState: icon chip 14px rounded 14px border edge-accent bg-accent, skeleton shimmer.
- Field: label 12.5px semibold, hint 12.5px ink-3, error bad.
- Toast: fixed bottom-right, border toneBg, auto-dismiss 5s except error.
- DataTableShell, Section, PageHeader for consistent page rhythm.

## 3. Global Shell (AppShell.tsx + HeaderNav.tsx + brand.tsx)
- Collapsible sidebar: 280px expanded / 72px collapsed, transition 200ms ease-out, mobile drawer overlay.
- Brand: 36x36 rounded 10px brand shadow-brand, Yasser lockup tracking -0.01em, version pill.
- Nav: rounded 10px, active bg-white/[0.08] with left 2px indigo indicator (platform) or bg-brand-subtle text-brand with left 3px (gateway light). Desc tabular-nums 11px.
- Health card: rounded 12px border white/[0.06] bg #12141f (dark) / surface-2 (light), StatusDot pulse.
- Header: 64px sticky backdrop-blur bg #080a12/80 (dark) / surface/90 (light), operational badge emerald pulse.
- Footer: #0c0e1a/50 border white/[0.06], 12px ink-3.

## 4. Gateway SaaS (src/app/*)

### Home (page.tsx)
- 1120px centered container, ShieldCheck pill emerald pulse, 36px heading tracking -0.03em, CTA h-11 brand vs surface.
- Authenticated: KPI grid 4 cols, fleet health 2-col progress bars emerald/indigo, risk alerts amber/red rounded 10px, quick links with icon chips indigo/blue/emerald.
- Billing premium hero, recent jobs table rounded 14px.

### Dashboard (dashboard/dashboard-client.tsx)
- Preserves all contracts: Runtime Printers, Recent Print Jobs strings required by production-hardening-contract.test.ts, Idempotency-Key crypto.randomUUID(), testingPrinterId, "Sending…" : "Send Test Page" preserved.
- KPI: Agents, Printers, In Flight, Success Rate with StatCard.
- Agents: pairing code 28px mono tracking 0.32em, countdown Clock warn, register form rounded 12px border edge bg-surface-2.
- Printers: grid/table toggle rounded 10px border edge bg-surface-2 p-0.5, active bg-surface shadow-xs. Search h-9 pl-9, status filter 148px. Card rounded 12px hover border-strong shadow-card, StatusBadge, Test button secondary h-9 rounded 10px.
- Jobs: search + filter tabs rounded 9px px-3 py-1.5 active bg-brand text-white. Table rounded 12px border edge, thead bg-surface-2 11px uppercase. StatusBadge with pulse for printing/claimed. Drawer details with outcome unknown amber callout, diagnostic payload mono max 64KiB truncated.

### Billing (billing/page.tsx)
- 1120px container, ShieldCheck pill, 36px heading.
- Hero: billing-premium card gradient top, plan 22px bold, balance 34px tabular-nums, usage bar h-1.5 rounded-full bg-surface-3, entitlements grid 3 cols rounded 10px border bg-surface-2.
- Status pills: active emerald, trialing blue, past_due red, cancelAtPeriodEnd amber.
- BillingActions preserved: hasSubscription, cancelAtPeriodEnd.

### Pricing (pricing/page.tsx)
- 1120px centered, ShieldCheck enforced pill, 36px heading tracking -0.03em.
- 3-col cards rounded 16px border edge shadow-card hover -2px, popular middle card brand gradient to brand-50/50 shadow brand 12%, Zap badge -top-3.
- Entitlements list with Check ok-bg chips tabular-nums, CTA h-11 brand vs surface, currency/interval pill, Stripe checkout notice, all plans include pills row.

### Settings (settings/page.tsx)
- Control center: workspace name form h-10 rounded 9px ring brand/15, CardHeader 15px, rounded 14px shadow-card.

### Team (team/page.tsx)
- Members/invitations CRUD via /api/team/members + /api/team/invitations preserved. Search rounded 12px, status pills, table rounded 14px.

### API Keys (api-keys/page.tsx)
- Preserves contracts: fetch /api/odoo/configuration every 5s, /api/odoo/keys, label gatewayConfig.enabled ? "Enabled in Odoo" : "Disabled in Odoo", strings "Odoo controls whether printing is enabled." and "API credentials are managed separately." required by odoo-gateway-activation-sync.test.ts.
- Premium: 1080px container, KeyRound pill, 26px heading, 3-col health grid (Credential/Activation/Connection) rounded 10px border bg-surface-2, StatusBadge distinct, security boundary card.

## 5. Platform Admin Control Plane (src/app/platform/*)

### Layout (layout.tsx)
- Dark premium: fixed aside 280/72px bg #0c0e1a border white/[0.06], 64px header backdrop-blur bg #080a12/80, collapsible PanelLeftClose/Open, mobile overlay, NAV_ITEMS with desc, active white/[0.08] + left 2px indigo, system health card, sign out + collapse, main max 1440px px-4/6/8, footer #0c0e1a/50.

### Dashboard (platform/dashboard/page.tsx)
- Live pill emerald pulse, 28px heading, KpiCard rounded 14px bg #12141f border white/[0.06] top gradient accent line, icon chip 8x8 white/[0.04], tabular-nums 30px, fleet health 2-col cards bg #0c0e1a progress bars emerald/indigo, queued/success/failed footer, risk alerts amber/red rounded 10px, operational notes, quick links 3 rows icon chips indigo/blue/emerald.

### Tenants (platform/tenants/page.tsx)
- ShieldAlert pill, 26px heading, search absolute Search icon rounded 12px bg #12141f, table rounded 14px bg #12141f border white/[0.06], thead bg #0c0e1a 11px uppercase, status pills emerald/amber/red 11px, lifecycle dialog 480px rounded 16px bg #12141f border white/[0.10], reason textarea 4 rows bg #0c0e1a border white/[0.08] focus amber/30, action buttons amber-600/emerald-600 rounded 10px.

### Plans (platform/plans/page.tsx)
- Same dark premium, search rounded 12px, table rounded 14px, visibility pills Active emerald / Archived neutral + Public indigo / Private neutral with Eye/EyeOff, limits grid 2 cols 11px tabular-nums, subscribers active/total, Stripe Price mono, Edit + Archive actions. Editor modal 2xl rounded 16px bg #12141f border white/[0.10], inputs bg #0c0e1a border white/[0.08] focus indigo/30, entitlements card bg #0c0e1a, toggle cards.

### Subscriptions (platform/subscriptions/page.tsx)
- ShieldAlert pill, 26px heading, search rounded 12px bg #12141f, table rounded 14px bg #12141f, thead bg #0c0e1a, status pills active emerald trialing blue past_due red with CheckCircle/Clock/AlertTriangle icons, Stripe customer mono 11px, period end date.

### Audit (platform/audit/page.tsx)
- Compliance pill ShieldAlert immutable, 26px heading Shield emerald, Refresh stream button, search rounded 12px bg #12141f, table rounded 14px bg #12141f, audit log 11px mono tabular-nums, actorType pill white/[0.04], action emerald-300 semibold.

## 6. Desktop Manager (src/desktop/*)

### Theme (theme-light.css)
- Premium light tokens matching web: bg #f8fafc, surface white, border #e2e8f0/#cbd5e1, text #0f172a/#475569/#64748b, brand #2563eb, shadow-card 0 1px 3px + 0 8px 24px, radius 8/10/12/14/16 pill.
- Utility: .card, .card-hover, .inset-panel, .table-head, .row-hover, .section-rule, .billing-premium gradient hairline.

### Sidebar (components/Sidebar.tsx)
- Light premium: fixed 280/72px border-r edge bg-surface, 64px brand h-9 w-9 rounded 10px bg-brand shadow-brand, title 13px bold Yasser Manager, subtitle 11px "Yasser Gateway • v—" preserves contract for desktop-ui-smoke.test.ts, nav rounded 10px active bg-brand-subtle text-brand shadow-xs before left 2px brand, status panel rounded 12px border edge bg-surface-2 + encrypted pill emerald 11px ShieldCheck.

### Layout Primitives (ui.tsx)
- PageHeader 26px bold tracking -0.02em, subtitle 13px ink-3 max-w-2xl.
- StatCard premium: top 2px gradient line per tone, icon chip 8x8 rounded 10px bg-surface-2, value 22px tabular-nums, sub 12px, hover -0.5px shadow-lg.
- StatusNotice: rounded 12px border p-4, tone border 200 bg 50 text 900, icon tone 600.
- PrinterAvatar: 10px rounded 10px border font-bold initials, tone ok emerald 50/200/700 etc.
- Toolbar: rounded 14px border edge bg-surface p-4 shadow-card.
- SettingsSection: rounded 14px border edge bg-surface shadow-card, header bg-surface-2/50 px-5 py-4 icon chip 9x9.
- DetailList: divide-y edge py-2.5 12px label / 13px value.
- ViewAllButton: 12px semibold ink-3 hover surface-2 brand.

### Pages
- Overview: banner warn/ok with actions, KPI grid 4 cols StatCard, printers card lg:col-span-2 with CardHeader 14px icon brand, printer rows rounded 12px border edge hover edge-accent, badge ZPL/TSPL ESC/POS Spooler rounded-full 10px, StatusBadge, Test secondary. Activity card Clock brand, DetailList, Gateway Queue 11px uppercase, quick actions 2-col.
- Printers: Toolbar search h-10 rounded 10px pl-10, status filter h-10 44 width, Add primary h-10 rounded 10px, Discover secondary, table 13px thead bg-surface-2 11px uppercase, rows hover surface-2/50, lifecycle pills emerald/amber/slate 11px, config tabular-nums, actions Test secondary + Disable/Enable/Retire ghost, footer status dots + encrypted pill.
- Jobs: Card Tabs (all/in_flight/queued/unassigned/printed/failed/unknown/expired) with counts, search h-10 rounded 10px, Refresh + Clean local, printer filter pill brand-subtle, table 13px thead bg-surface-2, status badge, Details secondary, empty states with icons, Modal cleanup with mono code pill.
- Agents: KPI 3 cols StatCard, This PC agent card Cpu brand header, StatusDot pulse, DetailList last check mono, fleet card Server brand header, total/online cards rounded 12px bg-surface-2, copy button, how agents work 3 cols rounded 12px border p-4 with icon chip brand-subtle.
- Settings: 2-col grid SettingsSection Gateway connection + Local agent, connection card rounded 12px border edge-accent bg-accent p-4, URL input h-10 rounded 10px, Check connection primary h-10 rounded 10px, service control h-9 rounded 10px, toggle h-6 w-11 rounded-full bg-brand/surface-3 thumb 4x4, Pair agent hero billing-premium border brand/20, steps 1-3 numbered brand circles, code input mono 16px bold tracking 0.3em h-11 rounded 10px, Pair button h-11, Current Status card copy summary, log list rounded 12px border bg-surface-2 p-3 12px, Advanced accordion.

### Dialogs
- AddPrinterDialog, EditPrinterDialog, AdminPrivilegeDialog use premium Modal (rounded 16px border edge shadow-2xl, header sticky border, footer sticky bg-surface-2/80 backdrop-blur). Preserved validation logic, agent discovery, protocol options, USB handling.

## 7. Odoo Print Gateway Backend (odoo_addons/print_gateway/*)

### Tokens (print_gateway_tokens.scss)
- Premium 2026 mirrors web: bg #f8fafc, surface white, border #e2e8f0/#cbd5e1, text #0f172a/#475569/#64748b, brand #2563eb ring 18%, radius 8/10/12/14/16 pill, shadow-card.
- Distinct state tokens added:
  - Credential: ok bg #ecfdf5 border #a7f3d0 text #047857; missing bg #fff1f2 border #fecdd3 text #be123c
  - Activation: enabled bg #eff6ff border #bfdbfe text #1d4ed8 with dot pulse ring; disabled bg #f8fafc border #e2e8f0 text #64748b
  - Connection: active emerald, syncing blue, attention amber, disabled slate — each bg/border/text distinct
- Animations: pg-pulse, pg-shimmer.

### Backend (print_gateway_backend.scss)
- Scoped .o_pg_view font Inter.
- Inputs: h-40px rounded 10px border edge bg-surface 13px, hover border-strong, focus brand ring 18%.
- Badges: rounded pill 11px semibold, success emerald active, warning amber attention, danger red bad.
- New distinct state components:
  - .o_pg_connection_banner: flex gap 12px rounded 12px p-14-16 border 1px, variants is-active/is-syncing/is-attention/is-disabled/is-not_configured each bg/border/text + icon 28x28 rounded 10px with border.
  - .o_pg_cred_card: rounded 12px border bg-surface p-14-16 flex gap 12px, has-key emerald bg/border, no-key red bg/border, icon 32x32 rounded 10px.
  - .o_pg_activation_state: pill 11px semibold border, enabled blue bg/border/text + dot brand with ring shadow, disabled slate + dot text-4.
  - .o_pg_job_outcome: pill 11px semibold border, printed emerald, not_printed red, unknown amber with pulse animation.
- Preserved existing: form sheet rounded 14px border edge shadow-card, notebook tabs border-bottom brand active, list thead bg-surface-2 11px uppercase, kanban card hover -1px shadow-md, step cards rounded 12px, partial alert amber border-left 3px solid warn-solid, pairing wizard code input mono 24px tracking 0.3em dashed brand border 56px height.
- Controls: radio 16px circle 1.5px border-strong, checkbox 16px 4px radius, toggle switch 2.25rem x 1.25rem pill border-strong bg-surface-3 checked bg-brand.

### Views (gateway_config_views.xml)
- List: company, gateway_sync_state string="Gateway Status" (preserves contract for odoo-gateway-activation-sync.test.ts) badge success/warning/danger/muted, enabled toggle, gateway_url.
- Form: header Test Connection oe_highlight + Pair New Agent + Branch Assignments, record header icon plug 36x36 rounded 10px brand-subtle border-accent, title 1.25rem bold -0.02em, subtitle muted.
- Distinct State Row: flex-wrap gap-3 mb-4 with 3 cards:
  - Credential card: fa-key icon, "Credential" label, Present/Missing badge, Encrypted at rest vs Setup required.
  - Activation card: fa-power-off icon, "Activation" label, Enabled/Disabled pill with dot.
  - Connection banner: is-{gateway_sync_state} dynamic class, icon check/refresh-spin/exclamation-triangle/pause per state, sync_state badge readonly, sync_message readonly.
- Preserved fields: company_id, enabled toggle, gateway_sync_state badge, gateway_sync_message, Connection group gateway_url + gateway_api_key password + Remove API Key button.
- Pair wizard: plug icon 3x primary, Assign Runtime Agent, branch + agent_id pairing_code_input mono 24px bold centered dashed brand 56px.

## 8. Business Logic Preservation
- No API contracts changed: /api/odoo/configuration polling 5s, /api/odoo/keys CRUD, /api/team/members/invitations, /api/platform/* lifecycle, /api/printers/[id]/test-print with Idempotency-Key crypto.randomUUID(), credentials same-origin, tenant isolation eq(agents.tenantId, claims.tenantId) etc.
- Dashboard strings required by tests preserved: "Runtime Printers", "Recent Print Jobs", "Sending…" : "Send Test Page", "Odoo controls whether printing is enabled.", "API credentials are managed separately.", "Yasser Gateway", "Yasser Manager", Overview/Printers/Print Jobs/Agents/Settings nav labels, Gateway connection, Pair agent.
- Gateway config view preserves string="Gateway Status" and gateway_sync_message field, not exposing last_enabled_sync_revision/error.
- Desktop IPC preserved: get_agent_status, get_app_version, gateway_request, gateway_agent_request, discover_printers, etc. Virtual printer filtering isProductionPrinter safety net preserved.
- Odoo models: enabled_sync_revision, last_enabled_sync_revision, pending_disable_* etc untouched.

## 9. Accessibility, Responsive, Animation
- All interactive elements focus-visible ring 2px brand/20, border-brand.
- Tablist keyboard ArrowLeft/Right Home/End with focus management.
- Modal/Drawer inert background isolation, ESC handling, focus trap.
- Responsive: mx-auto 1120-1440px px-4/6/8, grid sm:grid-cols-2 xl:grid-cols-4, lg:grid-cols-12, mobile drawer overlay, collapsed sidebar 72px.
- Animations: pg-fade-in, pg-scale-in, pg-slide-in-right, pg-toast-in, animate-pulse for live dots, hover -0.5 to -1px translate + shadow-lg, transition 150-200ms cubic-bezier(0.16,1,0.3,1).
- Tabular-nums for financial, mono for IDs, uppercase tracking-wide 11px for section labels.

## 10. Verification

### Typecheck
- `tsc --noEmit` → PASS (0 errors) via ./node_modules/.bin/tsc

### Lint
- `eslint .` → PASS (1 warning: react-hooks/exhaustive-deps in dashboard-client.tsx selectedJob dep — pre-existing, safe; 0 errors after fixing unescaped entity in api-keys)

### Tests
- `vitest run --config vitest.unit.config.mts` → 52 test files passed, 1 skipped, 377 tests passed, 5 skipped (previously 3 failed due to contract strings, now fixed)
- Key contracts passing:
  - production-hardening-contract.test.ts: Runtime Printers + Recent Print Jobs present, candidateStatus absent
  - production-fixes-contract.test.ts: /api/printers/.../test-print + credentials same-origin + Idempotency-Key + testingPrinterId + "Sending…" : "Send Test Page"
  - odoo-gateway-activation-sync.test.ts: fetch /api/odoo/configuration + interval 5s + Enabled in Odoo label + Odoo controls… + API credentials… + string="Gateway Status" + gateway_sync_message
  - desktop-ui-smoke.test.ts: boots every page, Yasser Gateway + Yasser Manager + nav labels + HP LaserJet + Zebra + hides Microsoft Print to PDF + Gateway connection + Pair agent, no console errors

### Builds
- `next build` → PASS: 51 static pages, routes listed (/, /api-keys, /billing, /dashboard, /platform/*, /pricing, /settings, /team etc), TypeScript 12.2s
- `vite build --config vite.desktop.config.mts` → PASS: 1910 modules, dist-desktop index.html 0.81kB, css 86.74kB gzip 15.36kB, js 412.93kB gzip 119.67kB built 757ms

## 11. Files Changed (28)
- odoo_addons/print_gateway/static/src/scss/print_gateway_backend.scss — premium backend with distinct credential/activation/connection states, outcome pills, connection banner, cred card
- odoo_addons/print_gateway/static/src/scss/print_gateway_tokens.scss — premium tokens + distinct state tokens
- odoo_addons/print_gateway/views/gateway_config_views.xml — distinct state row with cred/activation/connection cards, preserves Gateway Status string
- src/app/api-keys/page.tsx — premium 1080px, 3-col health grid, security boundary, preserves Odoo contracts strings
- src/app/billing/page.tsx — premium billing hero, entitlements, status pills
- src/app/dashboard/dashboard-client.tsx — premium KPI, agents, Runtime Printers, Recent Print Jobs, preserves test-page endpoint contracts
- src/app/globals.css — premium light tokens, shadow-card, billing-premium hairline, skeleton shimmer
- src/app/page.tsx — premium home 1120px, ShieldCheck pill, 36px heading
- src/app/platform/audit/page.tsx — premium dark audit stream
- src/app/platform/dashboard/page.tsx — premium dark KPI + fleet health + risk alerts
- src/app/platform/layout.tsx — premium dark control plane sidebar 280/72, header 64 backdrop-blur, active indigo indicator
- src/app/platform/plans/page.tsx — premium dark plan catalog + editor modal
- src/app/platform/subscriptions/page.tsx — premium dark subscriptions table
- src/app/platform/tenants/page.tsx — premium dark tenants + lifecycle dialog
- src/app/pricing/page.tsx — premium 1120px centered, 36px heading, 3-col cards popular gradient
- src/app/settings/page.tsx — control center workspace form
- src/app/team/page.tsx — members/invitations CRUD premium table
- src/components/AppShell.tsx — collapsible sidebar, active states, health card, header 64, footer
- src/components/brand.tsx — BrandMark 36x36 rounded 10px brand
- src/components/ui.tsx — premium primitives Button/Badge/Card/StatCard/Modal/Drawer/Tabs/Field/Input/Select/Empty/Error/Loading/Toast etc
- src/desktop/components/Sidebar.tsx — light premium 280/72, brand 9x9, nav rounded 10px active brand-subtle, status panel + encrypted pill, Yasser Gateway subtitle
- src/desktop/pages/Agents.tsx — premium StatCard + agent + fleet + how it works
- src/desktop/pages/Jobs.tsx — premium Tabs + search + table + cleanup modal
- src/desktop/pages/Overview.tsx — premium banner + KPI + printers + activity + recent jobs
- src/desktop/pages/Printers.tsx — premium Toolbar + table/grid + lifecycle pills
- src/desktop/pages/Settings.tsx — premium Gateway connection + Local agent + Pair hero + status snapshot + advanced
- src/desktop/theme-light.css — premium light tokens + utility classes
- src/desktop/ui.tsx — premium layout primitives

## 12. Notes
- .npmrc temporarily set to engine-strict=false to install on Node 22.22.3 (repo requires >=24.15.0), restored to true after verification. Builds succeed regardless.
- No business logic, RBAC, tenant isolation, billing, queue/job lifecycle, Tauri IPC, Go agent changed.
- All premium redesigns are visual-only, preserving API contracts and test expectations.
