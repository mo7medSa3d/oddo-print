# Yaseir Gateway + Agent Desktop — TailGrids-inspired UI implementation

Date: 2026-10-09. Scope: appearance and presentation components, **not** job delivery or printer drivers.

## What the referenced page provides

<https://tailgrids.com/docs/components> is a **component directory**, not one React component called `Components`. Each entry (Button, Card, Badge, Navigation Menu, Sidebar, Tabs, etc.) has its own props. The upstream documentation shows TailGrids v3.0, built with React and Tailwind CSS. The library's public license page allows use and customization in commercial projects but separately limits redistribution: <https://tailgrids.com/license>. This repository therefore implements its **own** visual equivalents using its existing React/Tailwind primitives; no TailGrids source, assets or package have been copied into this project. We do not claim that the local components are official TailGrids modules.

### Official component APIs (selected)

| TailGrids docs | Selected upstream props | Yaseir adaptation |
|---|---|---|
| [Button](https://tailgrids.com/docs/components/button) | `variant`, `appearance`, `size`, `iconOnly`, `pending`, `disabled`, `onPress` | Existing shared `Button`: `variant`, `appearance="fill|outline"`, `size="xs|sm|md|lg"`, `iconOnly`, `pending`, `disabled`, **`onClick`** (we retain native HTML/Next semantics rather than claiming React Aria `onPress`). |
| [Card](https://tailgrids.com/docs/components/card) | `Card`, `CardHeader`, `CardContent`, `CardFooter`, `CardTitle`, `className` | Existing shared `Card`, `CardHeader`, `Section`, and semantic grouped surfaces. |
| [Badge](https://tailgrids.com/docs/components/badge) | `size`, `color`, icons, `className` | `StatusBadge` retains the product-specific `tone`, `label`, optional `icon` and evidence-accurate `pulse`; adds pill styling and `lg` size. |
| [Sidebar](https://tailgrids.com/docs/components/sidebar) | `SidebarProvider`: `defaultOpen`, `open`, `onOpenChange`; `Sidebar`: `variant`, `collapsible`, `side` | Existing Gateway and Desktop sidebars retain router/keyboard/RTL ownership, icon collapse and mobile dialog semantics; new Yaseir shell styles and `NavIconFrame` apply the look. |
| [Navigation Menu](https://tailgrids.com/docs/components/navigation-menu) | `value`, `onValueChange`, `orientation`, `delay`, `closeDelay` and links | Existing `TopNavbar` and `ConsoleNav` retain real links and route-aware selection. No incorrect custom menu state has been introduced. |
| [Tabs](https://tailgrids.com/docs/components/tabs) | `TabRoot(defaultValue,variant,direction)`, `TabTrigger(value, icon, badge)` | Existing accessible controlled `Tabs(tabs,active,onChange,counts,labels)` retains route/filter state and arrow/Home/End navigation, with new segmented-pill visuals. |
| [Breadcrumbs](https://tailgrids.com/docs/components/breadcrumbs) | `items` with `href` and `label` | `BreadcrumbTrail(parent,current,label)` is read-only context for current app page; no fake links to Desktop-local pages. |

## Applied design

- Light-first blue (`#3758F9`) on clean neutral backgrounds, larger card radii, subtle shadows, soft focus treatments, and contrast-tested status colors. Yaseir brand mark and business vocabulary remain unchanged.
- Gateway console: floating/collapsible rail on desktop, route-aware active indicator, breadcrumb top bar, real Command Palette search trigger, compact mobile slide-in navigation.
- Gateway public/platform navigation: responsive 64px bar and consistent menu items. Server routes, permission gates and credential requests remain untouched.
- Agent Desktop: matching collapsible rail and status panels, route breadcrumb/header, keyboard-capable mobile navigation, route-keyed page-reveal transitions, responsive job/printer/settings content via shared Card/Button/Badge/Tabs.
- Existing notifications, dialogs, drawer/sheet, charts, printing status vocabulary, native commands and external printing transports are not replaced by demo implementations.
- All animations honor `prefers-reduced-motion: reduce`. Navigation uses logical `start`, `end`, `padding-inline-start` and mirrored RTL indicators; Arabic and English strings remain sourced from the existing catalogs.

## Usage in this codebase

```tsx
import { Button, Card, StatusBadge, Tabs } from "../components/ui";
import { BreadcrumbTrail, ShellSearchButton } from "../components/visual-system";

<>
  <BreadcrumbTrail parent="Workspace" current="Printers" label="Navigation" />
  <ShellSearchButton label="Search" hint="Ctrl+K" onClick={() => setPaletteOpen(true)} />
  <Card className="p-5">
    <StatusBadge tone="warn" label="Printer offline" />
    <Button variant="primary" appearance="outline" size="sm" onClick={retryProbe}>
      Retry connection
    </Button>
  </Card>
  <Tabs
    tabs={["all", "failed"] as const}
    active={filter}
    onChange={setFilter}
    labels={{ all: "All jobs", failed: "Failed" }}
  />
</>;
```

Use translated labels rather than these English literals in production. The example is illustrative and is not copied from upstream.

### Customization

The **sole design token source** is `src/app/globals.css`: `--brand`, `--bg`, `--surface`, `--border`, `--text`, radii `--r-*`, shadows `--shadow-*`, durations `--dur-*`. Tokens are also consumed by `src/desktop/theme-light.css` and Tailwind 4's `@theme` mappings. Scope shell presentation by `tg-*` classes. For app-specific status semantics keep `tone` / printer evidence independent of decorative animations. Dark mode uses the existing `data-theme="dark"` root and system preference initialization.

## Run checks and acceptance

```sh
npm ci
npm run typecheck
npm run lint
npm run desktop:vite:build
npm run build
node --experimental-vm-modules --test tests/tailgrids-ui-current-run.node.test.mjs tests/desktop-login-virtual-current-run.node.test.mjs tests/audit-gateway-offline.test.mjs
```

Expected toolchain: `.nvmrc` (Node 24.21.0), project lockfile, supported Windows/Tauri toolchain for installer. Verify screenshots **from the real running Gateway and Desktop**, at desktop width, 390px, 320px, 150% zoom, both `dir=ltr` and `dir=rtl`, both themes, keyboard only, reduced motion. Confirm no clipping of Check Connection, mobile drawer focus/escape, accessible search trigger, active tab and actual click handlers. Native Windows and real printer acceptance remain separate and NOT RUN unless actually performed.

**Local limitations at authoring time:** dependency registry DNS unavailable and `node` is 22 rather than 24; new Node boundary-harness tests and TSX parsing run, but a full Next/Vite/Tauri production build and real browser integration were not executed. These are NOT RUN, not PASS.
