/**
 * Isolated UI responsive contracts, runnable without a browser, Gateway, or
 * Windows Agent. They deliberately do not claim real layout/visual acceptance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => readFileSync(path.join(root, file), "utf8");

function loadSidebar() {
  const file = "src/desktop/components/Sidebar.tsx";
  const js = ts.transpileModule(source(file), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const react = {
    useRef: () => ({ current: null }),
    useEffect: () => undefined,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const m = { exports: {} };
  const imported = (name) => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    if (name === "react") return { ...react, default: react };
    if (name === "@radix-ui/react-dialog") return { Root: "radix-root", Portal: "radix-portal", Overlay: "radix-overlay", Content: "radix-content", Title: "radix-title" };
    if (name === "lucide-react") return new Proxy({}, { get: (_, k) => String(k) });
    if (name === "../../components/ui") return { StatusDot: "status-dot" };
    if (name === "../../components/brand") return { BrandMarkIcon: "brand-mark" };
    if (name === "../../components/visual-system") return { NavIconFrame: "nav-icon" };
    if (name === "../../i18n/react") return { useI18n: () => ({ t: (k) => k, formatTime: (v) => String(v) }) };
    throw Error(`Unexpected sidebar import ${name}`);
  };
  new Function("require", "module", "exports", js)(imported, m, m.exports);
  return m.exports.Sidebar;
}
function collect(node, testNode) {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((child) => collect(child, testNode));
  return [
    ...(testNode(node) ? [node] : []),
    ...collect(node.props?.children, testNode),
  ];
}
function renderSidebar(narrow) {
  const oldWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: narrow }) };
  try {
    const Sidebar = loadSidebar();
    const tree = Sidebar({
      page: "printers",
      navigate: () => undefined,
      items: [{ id: "printers", label: "Printers", icon: "printer-icon" }],
      collapsed: true,
      setCollapsed: () => undefined,
      sidebarOpen: narrow,
      setSidebarOpen: () => undefined,
      gatewayConnected: false,
      gatewayUrl: "https://example.test",
      isOnline: false,
      version: "1.0.0",
      lastStatusCheck: null,
    });
    const asides = collect(tree, (node) => node.type === "aside");
    assert.equal(asides.length, 1, "mobile and desktop both retain their semantic sidebar");
    const dialogCount = collect(tree, (node) => node.type === "radix-root").length;
    assert.equal(dialogCount, narrow ? 1 : 0, "only the narrow viewport needs a modal Radix wrapper");
    if (narrow) {
      assert.equal(collect(tree, (node) => node.type === "radix-overlay").length, 1);
      assert.equal(collect(tree, (node) => node.type === "radix-content").length, 1);
    }
    return asides[0];
  } finally {
    globalThis.window = oldWindow;
  }
}

test("mobile drawer keeps route labels when desktop rail was saved collapsed", () => {
  const aside = renderSidebar(true);
  assert.match(aside.props.className, /w-\[min\(320px,90vw\)\]/);
  assert.match(aside.props.className, /lg:w-\[var\(--sidebar-width\)\]/);
  assert.match(source("src/app/globals.css"), /--sidebar-width:\s*18rem/);
  assert.match(source("src/desktop/main.tsx"), /lg:ps-\[calc\(var\(--sidebar-width\)\+0\.75rem\)\]/);
  assert.equal(aside.props.tabIndex, -1);
  assert.equal(collect(aside, (n) => n.type === "span" && n.props.children === "Printers").length, 1);
});

test("desktop collapsed rail stays compact and does not print route labels", () => {
  const aside = renderSidebar(false);
  assert.match(aside.props.className, /lg:w-\[var\(--sidebar-collapsed\)\]/);
  assert.match(source("src/app/globals.css"), /--sidebar-collapsed:\s*5rem/);
  assert.match(source("src/desktop/main.tsx"), /lg:ps-\[calc\(var\(--sidebar-collapsed\)\+0\.75rem\)\]/);
  assert.equal(collect(aside, (n) => n.type === "span" && n.props.children === "Printers").length, 0);
});

test("opening mobile navigation never overwrites desktop compact preference", () => {
  const desktop = source("src/desktop/main.tsx");
  assert.match(desktop, /onClick=\{\(\) => setSidebarOpen\(true\)\}/);
  assert.doesNotMatch(desktop, /setCollapsed\(false\);\s*setSidebarOpen\(true\)/);
});

test("Platform mobile lists preserve lifecycle actions and audit evidence", () => {
  const tenants = source("src/app/platform/tenants/page.tsx");
  const audit = source("src/app/platform/audit/page.tsx");
  assert.match(tenants, /<ul className="divide-y divide-edge-subtle lg:hidden"/);
  assert.match(tenants, /filtered\.map\(\(tenant\) =>/);
  assert.match(tenants, /const items = tenantMenu\(tenant\)/);
  assert.match(tenants, /className="hidden min-w-0 overflow-x-auto/);
  assert.match(audit, /<ul className="divide-y divide-edge-subtle lg:hidden"/);
  assert.match(audit, /aria-controls=\{`audit-mobile-metadata-\$\{event\.id\}`\}/);
  assert.match(audit, /JSON\.stringify\(event\.metadata, null, 2\)/);
  assert.match(audit, /className="hidden min-w-0 overflow-x-auto/);
});

test("horizontal table navigation is offered only when overflow exists", () => {
  const ui = source("src/components/ui.tsx");
  const start = ui.indexOf("export function TableScroll({");
  const end = ui.indexOf("export function CopyButton({", start);
  const region = ui.slice(start, end);
  assert.match(region, /region\.scrollWidth - region\.clientWidth > 1/);
  assert.match(region, /new ResizeObserver\(syncOverflow\)/);
  assert.match(region, /tabIndex=\{overflowing \? 0 : undefined\}/);
  assert.match(region, /t\("ui\.scrollTable"\)/);
  assert.match(ui, /root\.scrollLeft \+= delta/);
  assert.doesNotMatch(ui, /scrollIntoView/);
});

test("mobile and RTL refinements remain scoped to the product UIs", () => {
  const css = source("src/app/globals.css");
  const odoo = source("odoo_addons/print_gateway/static/src/scss/print_gateway_backend.scss");
  const odooTokens = source("odoo_addons/print_gateway/static/src/scss/print_gateway_tokens.scss");
  const gateway = source("src/components/AppShell.tsx");
  const platform = source("src/components/platform/PlatformSidebar.tsx");
  assert.match(css, /\.tg-desktop-header-actions\s*\{/);
  assert.match(css, /env\(safe-area-inset-top, 0px\)/);
  assert.match(css, /@media \(max-width: 639\.98px\)/);
  assert.match(css, /\.tg-mobile-appbar \{/);
  assert.match(css, /\.tg-desktop-topbar\.tg-desktop-header \{/);
  assert.match(gateway, /<MobileAppBar/);
  assert.match(platform, /<MobileAppBar/);
  // Backend views opt into relative readable text. Mobile must not replace
  // those shared tokens with a smaller fixed size, nor resize the Odoo host.
  const bodyRem = Number(odooTokens.match(/--pg-fs-body:\s*([\d.]+)rem/)?.[1]);
  const helpRem = Number(odooTokens.match(/--pg-fs-small:\s*([\d.]+)rem/)?.[1]);
  assert.ok(bodyRem >= 1 && bodyRem <= 1.125, "body is 16–18px at the default root");
  assert.ok(helpRem >= 1, "help text retains a readable relative size");
  assert.match(odoo, /\.o_pg_view \{[\s\S]*?font-size: var\(--pg-fs-body\)/);
  assert.doesNotMatch(odoo, /--pg-fs-(?:body|small)\s*:/);
  assert.doesNotMatch(odoo, /(?:^|\n)(?:html|body|:root)\s*\{/);
  const en = source("src/i18n/messages/en.ts");
  const ar = source("src/i18n/messages/ar.ts");
  assert.match(en, /"ui\.scrollTable"/);
  assert.match(ar, /"ui\.scrollTable"/);
});
