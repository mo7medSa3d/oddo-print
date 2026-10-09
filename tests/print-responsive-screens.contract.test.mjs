import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

// Source-level contracts catch responsive regressions even in the standalone
// offline test lane. These do NOT substitute for a real browser/screen-size test.
test("Gateway printer cards remain available on phones for both view preferences", () => {
  const dashboard = read("src/app/dashboard/dashboard-client.tsx");
  assert.match(dashboard, /printerViewMode === "table" \? "xl:hidden" : ""/);
  assert.match(dashboard, /className="hidden min-w-0 overflow-x-auto xl:block"/);
  assert.match(dashboard, /className="hidden xl:block"/);
  assert.match(dashboard, /grid-cols-1 items-start gap-5 xl:grid-cols-12/);
});

test("Gateway console constrains mobile width and keeps overlays usable", () => {
  const shell = read("src/components/AppShell.tsx");
  const ui = read("src/components/ui.tsx");
  const css = read("src/app/globals.css");
  assert.match(shell, /main className="page-transition min-w-0 max-w-full"/);
  assert.match(shell, /max-w-\[85vw\]/);
  assert.match(ui, /card min-w-0 max-w-full/);
  assert.match(ui, /break-words text-md font-\[600\]/);
  assert.match(css, /overflow-x: clip/);
  assert.match(css, /\[dir="rtl"\] \.data-table \.font-mono/);
});

test("Desktop printers and jobs use readable cards rather than narrow tables", () => {
  const printers = read("src/desktop/pages/Printers.tsx");
  const jobs = read("src/desktop/pages/Jobs.tsx");
  const overview = read("src/desktop/pages/Overview.tsx");
  assert.match(printers, /divide-y divide-edge-subtle xl:hidden/);
  assert.match(printers, /hidden min-w-0 overflow-x-auto xl:block/);
  assert.match(jobs, /divide-y divide-edge-subtle lg:hidden/);
  assert.match(jobs, /hidden min-w-0 overflow-x-auto lg:block/);
  assert.match(overview, /divide-y divide-edge-subtle lg:hidden/);
  assert.match(overview, /hidden min-w-0 overflow-x-auto lg:block/);
});

test("Odoo 19 form and list mobile rules stay inside the print_gateway addon", () => {
  const css = read("odoo_addons/print_gateway/static/src/scss/print_gateway_backend.scss");
  assert.match(css, /@media \(max-width: 767\.98px\)/);
  assert.match(css, /\.o_pg_view \{/);
  assert.match(css, /\.o_pg_list \{/);
  assert.match(css, /\.o_list_renderer \{ max-width: 100%; overflow-x: auto; \}/);
  assert.match(css, /\.o_notebook \.nav-tabs \{/);
});
