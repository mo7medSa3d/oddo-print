/**
 * UI redesign regression harness: execute the real Yaseir component functions,
 * substituting only React rendering and the browser/Next/lucide boundaries.
 * Native browser, CSS layout, and Windows WebView acceptance are separate gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const reactRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' };
const lucide = new Proxy({}, { get(_target, name) { return String(name); } });
function loadReal(file, imported) {
  const code = ts.transpileModule(read(file), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const cjsModule = { exports: {} };
  const imports = (name) => {
    if (name === 'react/jsx-runtime') return reactRuntime;
    if (name === 'react') { const react = { createElement: jsx, createContext: () => ({ Provider: 'provider' }), useRef: (initial) => ({ current: initial }) }; return { ...react, default: react }; }
    if (name === 'lucide-react') return lucide;
    return imported(name);
  };
  new Function('require', 'module', 'exports', code)(imports, cjsModule, cjsModule.exports);
  return cjsModule.exports;
}

function walk(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  const matches = predicate(node) ? [node] : [];
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
  for (const child of children.flat(Infinity)) matches.push(...walk(child, predicate));
  return matches;
}

const shell = loadReal('src/components/visual-system.tsx', (name) => { throw Error(`Unexpected shell dependency ${name}`); });
const ui = loadReal('src/components/ui.tsx', (name) => {
  if (name === 'next/link') return { __esModule: true, default: 'next-link' };
  if (name === 'react-dom') return { createPortal: (node) => node };
  if (name === '../i18n/react') return { useI18n: () => ({ t: (x) => x }) };
  if (name === '../shared/job-vocabulary') return { printerTone: () => 'neutral', jobTone: () => 'neutral' };
  if (name === './brand') return {};
  throw Error(`Unexpected shared UI dependency ${name}`);
});

test('breadcrumb differentiates parent and active page without inventing a navigation link', () => {
  const view = shell.BreadcrumbTrail({ parent: 'Workspace', current: 'Printers', label: 'Navigation' });
  assert.equal(view.type, 'nav');
  assert.equal(view.props['aria-label'], 'Navigation');
  const parts = walk(view, node => node.type === 'span');
  assert.equal(parts[0].props.children, 'Workspace');
  assert.equal(parts[1].props.children, 'Printers');
  assert.equal(parts[1].props['aria-current'], 'page');
  assert.match(view.props.className, /min-w-0/);
});

test('shell search trigger is a real accessible button and invokes its handler exactly once', () => {
  let presses = 0;
  const trigger = shell.ShellSearchButton({ label: 'Search', hint: 'Ctrl+K', onClick: () => presses++ });
  assert.equal(trigger.type, 'button');
  assert.equal(trigger.props.type, 'button');
  assert.equal(trigger.props['aria-label'], 'Search');
  trigger.props.onClick();
  assert.equal(presses, 1);
});

test('active navigation icon has contrast treatment but no extra screenreader content', () => {
  const icon = shell.NavIconFrame({ active: true, children: 'Icon' });
  assert.equal(icon.props['aria-hidden'], true);
  assert.match(icon.props.className, /bg-surface/);
  assert.equal(icon.props.children, 'Icon');
});

test('outlined buttons keep their original click behavior and expose documented appearance', () => {
  let presses = 0;
  const button = ui.Button({ variant: 'primary', appearance: 'outline', size: 'xs', onClick: () => presses++, children: 'Save' });
  assert.equal(button.type, 'button');
  assert.equal(button.props['data-appearance'], 'outline');
  assert.equal(button.props.disabled, undefined);
  assert.match(button.props.className, /border-edge-accent/);
  button.props.onClick();
  assert.equal(presses, 1);
});

test('pending primary action disables duplicate submission without showing false-success', () => {
  const button = ui.Button({ variant: 'primary', pending: true, children: 'Check connection' });
  assert.equal(button.props.disabled, true);
  assert.equal(button.props['aria-busy'], true);
  assert.equal(button.props.type, 'button');
  assert.equal(walk(button, n => n.type === 'Loader2').length, 1);
});

test('status badges retain visible text and semantic status dots', () => {
  const badge = ui.StatusBadge({ tone: 'warn', label: 'Needs attention', pulse: false });
  assert.equal(badge.type, 'span');
  assert.match(badge.props.className, /tg-status-pill/);
  assert.equal(walk(badge, node => node.type === 'span' && node.props.children === 'Needs attention').length, 1);
  const dots = walk(badge, node => node.type === ui.StatusDot);
  assert.equal(dots.length, 1);
  assert.equal(dots[0].props.tone, 'warn');
  assert.equal(dots[0].props.pulse, false);
});

test('tabs preserve real handler and accessible selected state in TailGrids-style group', () => {
  let current = 'queued';
  const tabRoot = ui.Tabs({ tabs: ['queued', 'failed'], active: 'queued', onChange: v => { current = v; }, labels: { queued: 'Queued', failed: 'Failed' } });
  assert.equal(tabRoot.props.role, 'tablist');
  const tabs = walk(tabRoot, node => node.props?.role === 'tab');
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].props['aria-selected'], true);
  assert.equal(tabs[0].props['data-active'], true);
  assert.equal(tabs[1].props['aria-selected'], false);
  tabs[1].props.onClick();
  assert.equal(current, 'failed');
});

test('both shells consume shared navigation primitives and retain routes and page transitions', () => {
  const gateway = read('src/components/AppShell.tsx');
  const desktop = read('src/desktop/main.tsx');
  const desktopNav = read('src/desktop/components/Sidebar.tsx');
  const platformLayout = read('src/app/platform/layout.tsx');
  const platformSidebar = read('src/components/platform/PlatformSidebar.tsx');
  assert.doesNotMatch(gateway, /<BreadcrumbTrail/);
  assert.match(gateway, /<NavIconFrame active=\{active\}/);
  assert.match(gateway, /<ShellSearchButton/);
  assert.match(gateway, /<MobileAppBar/);
  assert.match(read('src/components/MobileAppBar.tsx'), /data-gateway-mobile-navigation/);
  assert.match(platformLayout, /<PlatformSidebar items=\{NAV_ITEMS\}/);
  assert.match(platformSidebar, /tg-console-rail/);
  assert.match(gateway, /main className="page-transition min-w-0 max-w-full"/);
  assert.match(desktop, /<header className="tg-desktop-topbar/);
  assert.match(desktop, /<Modal open=\{navSearchOpen\}/);
  assert.doesNotMatch(desktop, /<BreadcrumbTrail/);
  assert.match(desktop, /<PrintersPage s=\{state\}/);
  assert.match(desktop, /<JobsPage s=\{state\}/);
  assert.match(desktop, /key=\{page\} className="tg-view-reveal/);
  assert.match(desktopNav, /<NavIconFrame active=\{active\}/);
});

test('Gateway and Platform float above the page with an inset rounded rail; Desktop keeps its chrome', () => {
  const css = read('src/app/globals.css');
  const gateway = read('src/components/AppShell.tsx');
  const desktop = read('src/desktop/main.tsx');
  const rail = read('src/desktop/components/Sidebar.tsx');
  const platformSidebar = read('src/components/platform/PlatformSidebar.tsx');

  // Desktop Gateway/Platform navigation has an inset, radius and elevation,
  // with logical positions that work in both Arabic RTL and English LTR.
  assert.match(css, /\.tg-console-rail\s*\{\s*background: var\(--surface\);\s*border: 1px solid var\(--border\);\s*box-shadow: var\(--shadow-md\);/);
  assert.match(css, /\.tg-console-rail\s*\{\s*inset-block: 12px;\s*inset-inline-start: 12px;\s*border-radius: var\(--r-2xl\);\s*overflow: hidden;/);
  assert.match(css, /\.tg-console-content\s*\{\s*padding-inline-start: calc\(var\(--nav-w\) \+ 12px\);/);
  assert.match(css, /\.tg-console-content\s*\{ padding-inline-start: 0; \}/);
  for (const shell of [gateway, platformSidebar]) {
    assert.match(shell, /tg-console-rail fixed/);
    assert.match(shell, /tg-console-content min-w-0 max-w-full/);
  }
  assert.match(gateway, /area="gateway"/);
  assert.match(platformSidebar, /area="platform"/);
  assert.match(read('src/components/MobileAppBar.tsx'), /tg-mobile-appbar sticky top-0/);
  assert.doesNotMatch(gateway, /tg-console-topbar/);
  assert.match(gateway, /flex min-h-18 shrink-0 items-center gap-2 border-b/);

  // Tauri Windows chrome is unchanged.
  assert.match(css, /\.tg-desktop-rail\s*\{\s*background: var\(--surface\);\s*border: 1px solid var\(--border\);\s*box-shadow: var\(--shadow-md\);/);
  assert.match(css, /\.tg-desktop-rail\s*\{\s*inset-block: 12px;\s*inset-inline-start: 12px;\s*border-radius: var\(--r-2xl\)/);
  assert.match(desktop, /tg-desktop-topbar tg-desktop-header sticky top-2/);
  assert.match(desktop, /lg:mx-3/);
  assert.match(desktop, /lg:ps-\[calc\(var\(--sidebar-collapsed\)\+0\.75rem\)\]/);
  assert.match(desktop, /lg:ps-\[calc\(var\(--sidebar-width\)\+0\.75rem\)\]/);
  assert.match(rail, /lg:inset-y-3 lg:start-3/);
  assert.match(rail, /flex min-h-16 shrink-0 items-center gap-3 border-b/);
});

test('console hides only the page scrollbar without disabling native scrolling', () => {
  const css = read('src/app/globals.css');
  assert.match(css, /html:has\(\.tg-console-content\),\s*html:has\(\.tg-console-content\) body\s*\{\s*scrollbar-width: none;/);
  assert.match(css, /html:has\(\.tg-console-content\)::\-webkit-scrollbar/);
  assert.match(css, /html:has\(\.tg-console-content\) body::\-webkit-scrollbar/);
  const baseStart = css.indexOf('/* The console\'s document scrollbar');
  const baseEnd = css.indexOf('@media (max-width: 767.98px)', baseStart);
  const rule = css.slice(baseStart, baseEnd);
  assert.ok(baseStart >= 0 && baseEnd > baseStart);
  assert.doesNotMatch(rule, /overflow(?:-y)?:\s*(?:hidden|clip)/);
  assert.match(read('src/components/AppShell.tsx'), /overflow-y-auto py-3/);
  assert.match(read('src/components/platform/PlatformSidebar.tsx'), /overflow-y-auto py-3/);
});

test('dashboard titles merge with the web canvas instead of a full-width tinted box', () => {
  const css = read('src/app/globals.css');
  const header = ui.PageHeader({
    title: 'Print dashboard',
    description: 'Current jobs',
    actions: jsx('button', { children: 'Refresh' }),
  });
  const sticky = ui.PageHeader({ title: 'Sticky', sticky: true });
  assert.match(header.props.className, /tg-page-heading/);
  assert.doesNotMatch(header.props.className, /border-b|glass-chrome|shadow/);
  assert.match(sticky.props.className, /glass-chrome border-b border-edge-subtle/);
  const headerLayout = walk(header, node =>
    typeof node.props?.className === 'string' && node.props.className.includes('justify-between')
  );
  assert.equal(headerLayout.length, 1);
  assert.match(headerLayout[0].props.className, /flex-wrap items-start/);
  const headerContent = walk(header, node =>
    typeof node.props?.className === 'string' && node.props.className.includes('lg:pt-7')
  );
  assert.equal(headerContent.length, 1);
  assert.match(headerContent[0].props.className, /pb-0/);

  // Gateway + Platform share the same solid canvas and logical RTL sidebar.
  assert.match(css, /\.tg-console-content\s*\{\s*min-height: 100vh;\s*background: var\(--bg\);/);
  assert.match(css, /\.tg-page-heading:not\(\.glass-chrome\)\s*\{\s*background: transparent;\s*border: 0;\s*box-shadow: none;/);
  assert.match(css, /border: 1px solid var\(--border\)/);
  assert.match(css, /\.tg-desktop-rail\s*\{\s*background: var\(--surface\);/);
});

test('motion remains optional and Arabic/English themes share one token layer', () => {
  const css = read('src/app/globals.css');
  const desktopCss = read('src/desktop/theme-light.css');
  assert.match(css, /\.tg-nav-item\[data-active="true"\]/);
  assert.match(css, /\[dir="rtl"\] \.tg-nav-item/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.tg-view-reveal\s*\{\s*animation: none !important/);
  assert.match(desktopCss, /globals\.css is the single theme source/);
});
