/** In-process component contracts, without network, Next, or native WebView. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(base, p), 'utf8');

function loadMobileAppBar() {
  const compiled = ts.transpileModule(read('src/components/MobileAppBar.tsx'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const m = { exports: {} };
  const imports = (id) => {
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (id === 'lucide-react') return { Menu: 'menu-icon', Search: 'search-icon' };
    if (id === './brand') return { BrandMarkIcon: 'brand-icon' };
    if (id === '../i18n/react') return { useI18n: () => ({ t: (key) => key }) };
    throw new Error(`Unexpected dependency: ${id}`);
  };
  new Function('require', 'module', 'exports', compiled)(imports, m, m.exports);
  return m.exports.MobileAppBar;
}
function nodes(value, predicate) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((v) => nodes(v, predicate));
  return [...(predicate(value) ? [value] : []), ...nodes(value.props?.children, predicate)];
}
const render = loadMobileAppBar();

test('Gateway mobile header has a 44px menu trigger and working search affordance', () => {
  let opened = 0; let searched = 0;
  const view = render({ area: 'gateway', title: 'Dashboard', section: 'Workspace', navigationId: 'gateway-mobile-nav', navigationOpen: false, onOpenNavigation: () => opened++, onSearch: () => searched++ });
  assert.equal(view.type, 'header');
  assert.match(view.props.className, /sticky top-0/);
  assert.match(view.props.className, /lg:hidden/);
  const buttons = nodes(view, (node) => node.type === 'button');
  assert.equal(buttons.length, 2);
  assert.match(buttons[0].props.className, /h-11 w-11/);
  assert.equal(buttons[0].props['aria-haspopup'], 'dialog');
  assert.equal(buttons[0].props['aria-expanded'], false);
  assert.equal(buttons[0].props['aria-controls'], 'gateway-mobile-nav');
  assert.equal(buttons[0].props['data-gateway-mobile-navigation'], true);
  buttons[0].props.onClick(); buttons[1].props.onClick();
  assert.equal(opened, 1);
  assert.equal(searched, 1);
  assert.equal(nodes(view, (node) => node.type === 'brand-icon').length, 1);
});

test('Platform mobile header uses the same chrome without an inert search button', () => {
  const view = render({ area: 'platform', title: 'Tenants', section: 'Control plane', navigationId: 'platform-mobile-nav', navigationOpen: true, onOpenNavigation: () => {} });
  const buttons = nodes(view, (node) => node.type === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props['data-platform-mobile-navigation'], true);
  assert.equal(buttons[0].props['aria-expanded'], true);
  assert.equal(buttons[0].props['aria-controls'], 'platform-mobile-nav');
  assert.equal(nodes(view, (node) => node.type === 'div' && node.props.title === 'Tenants').length, 1);
});

test('mobile chrome and desktop overflow preserve RTL, safe areas, and a one-row toolbar', () => {
  const css = read('src/app/globals.css');
  const desktop = read('src/desktop/main.tsx');
  const bar = read('src/components/MobileAppBar.tsx');
  assert.match(css, /\.tg-mobile-appbar\s*\{[\s\S]*?padding-top: env\(safe-area-inset-top, 0px\)/);
  assert.match(css, /\.tg-desktop-topbar\.tg-desktop-header\s*\{[\s\S]*?flex-wrap: nowrap/);
  assert.doesNotMatch(css, /\.tg-mobile-main\s*\{/);
  assert.match(bar, /min-w-0 flex-1 text-start/);
  assert.match(desktop, /<ActionMenu/);
  assert.match(desktop, /aria-controls="desktop-mobile-nav"/);
  assert.match(desktop, /sm:hidden/);
  assert.match(desktop, /onSelect: toggleTheme/);
  assert.match(desktop, /onSelect: \(\) => setLocale\(code\)/);
});
