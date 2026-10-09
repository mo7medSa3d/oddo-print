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
  assert.ok([badge.props.children].flat(Infinity).includes('Needs attention'));
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
  assert.match(gateway, /<BreadcrumbTrail/);
  assert.match(gateway, /<ShellSearchButton/);
  assert.match(gateway, /main className="page-transition min-w-0 max-w-full"/);
  assert.match(desktop, /<header className="tg-desktop-topbar/);
  assert.match(desktop, /<Modal open=\{navSearchOpen\}/);
  assert.doesNotMatch(desktop, /<BreadcrumbTrail/);
  assert.match(desktop, /<PrintersPage s=\{state\}/);
  assert.match(desktop, /<JobsPage s=\{state\}/);
  assert.match(desktop, /key=\{page\} className="tg-view-reveal/);
  assert.match(desktopNav, /<NavIconFrame active=\{active\}/);
});

test('Gateway and Agent float at matching 12px app-frame insets with a unified surface', () => {
  const css = read('src/app/globals.css');
  const gateway = read('src/components/AppShell.tsx');
  const desktop = read('src/desktop/main.tsx');
  const rail = read('src/desktop/components/Sidebar.tsx');
  const floatingCss = css.slice(css.indexOf('  .tg-console-topbar,'));
  assert.match(floatingCss, /border: 1px solid var\(--border\)/);
  assert.match(floatingCss, /border-radius: var\(--r-2xl\)/);
  assert.match(floatingCss, /box-shadow: var\(--shadow-md\)/);
  assert.match(css, /\.tg-console-content\s*\{\s*padding-inline-start: calc\(var\(--nav-w\) \+ 12px\)/);
  assert.match(gateway, /tg-console-topbar sticky top-3/);
  assert.match(gateway, /lg:mx-3 lg:mt-3/);
  assert.match(gateway, /tg-console-topbar glass-chrome sticky top-2/);
  assert.match(gateway, /flex h-14 shrink-0 items-center gap-2 border-b/);
  assert.match(desktop, /tg-desktop-topbar sticky top-2/);
  assert.match(desktop, /lg:mx-3/);
  assert.match(desktop, /lg:ps-\[92px\]/);
  assert.match(desktop, /lg:ps-\[276px\]/);
  assert.match(rail, /lg:inset-y-3 lg:start-3/);
  assert.match(rail, /flex h-14 shrink-0 items-center gap-3 border-b/);
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
