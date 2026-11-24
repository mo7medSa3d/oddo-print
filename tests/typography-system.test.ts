import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The typography system is specified once and consumed three times.
 *
 * These tests are the executable form of that rule: they fail when an
 * application stops referencing the shared tokens, when the Odoo add-on's
 * standalone copy drifts from the canonical file, or when a printable
 * surface hardcodes a family or a size instead of referencing a token.
 *
 * The receipt raster is a deliberate, documented exception: it is a
 * fixed-dot canvas measured against the printer's dot budget, its metrics
 * are pinned by the geometry fixture, and it is captured with font
 * embedding disabled. Its values are therefore declared as tokens in place
 * and must keep rendering exactly as before.
 */
const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8");

const CANONICAL = "typography/tokens.css";
const ODOO_COPY = "odoo_addons19/print_gateway/static/src/css/typography_tokens.css";

describe("shared typography system", () => {
  it("ships one canonical token file", () => {
    expect(existsSync(resolve(process.cwd(), CANONICAL))).toBe(true);
    const tokens = read(CANONICAL);
    for (const name of [
      "--typo-font-stack",
      "--typo-font-stack-system",
      "--typo-weight-regular",
      "--typo-weight-medium",
      "--typo-weight-semibold",
      "--typo-weight-bold",
      "--typo-fs-display",
      "--typo-fs-section",
      "--typo-fs-body",
      "--typo-fs-emphasis",
      "--typo-fs-label",
      "--typo-fs-footer",
      "--typo-lh-arabic",
      "--typo-lh-latin",
      "--typo-lh-mixed",
      "--typo-space-table-row",
      "--typo-color-primary",
      "--typo-color-secondary",
    ]) {
      expect(tokens).toContain(`${name}:`);
    }
  });

  it("keeps the Odoo module copy byte-identical to the canonical file", () => {
    // The add-on is installed standalone, so it cannot import a file from
    // outside the module. scripts/check-typography-tokens.py fails closed on
    // any drift; this asserts the same invariant inside the test suite.
    expect(read(ODOO_COPY)).toBe(read(CANONICAL));
  });

  it("uses the shared family stack in the web app", () => {
    const css = read("src/app/globals.css");
    expect(css).toContain(`@import "../../${CANONICAL}";`);
    expect(css).toContain("--font-sans: var(--typo-font-stack-latin);");
    expect(css).toContain("--font-sans: var(--typo-font-stack-arabic);");
    // The RTL override used to swap the family list; the shared stack now
    // carries both faces and lets the engine resolve per glyph.
    expect(css).not.toContain("--font-ibm-plex-sans-arabic, \"Noto Sans Arabic\"");
    expect(css).not.toContain("Segoe UI Variable Display");
  });

  it("uses the shared family stack in the desktop app", () => {
    const css = read("src/desktop/theme-light.css");
    expect(css).toContain(`@import "../../${CANONICAL}";`);
    expect(css).toContain("font-family: var(--typo-font-stack-latin);");
    expect(css).toContain("font-family: var(--typo-font-stack-arabic);");
    // The installed Tauri app must not depend on system-installed fonts.
    // v8-style: Desktop ships self-hosted Thmanyah Sans (Design Guide v2.1),
    // not IBM Plex — the contract is updated to the new intended face while
    // keeping every structural assertion (shared stack, @font-face,
    // font-display: block, bundled files, no system-font dependence).
    expect(css).toContain('@font-face');
    expect(css).toContain('font-family: "Thmanyah Sans"');
    expect(css).toContain("font-display: block");
    for (const weight of ["300", "400", "500", "700", "900"]) {
      expect(css).toContain(`font-weight: ${weight};`);
    }
    for (const file of [
      "thmanyahsans-Light.otf",
      "thmanyahsans-Regular.otf",
      "thmanyahsans-Medium.otf",
      "thmanyahsans-Bold.otf",
      "thmanyahsans-Black.otf",
    ]) {
      expect(css).toContain(`./fonts/${file}`);
      expect(existsSync(resolve(process.cwd(), "src/desktop/fonts", file))).toBe(true);
    }
  });

  it("uses the shared family stack in the Odoo add-on", () => {
    const scss = read("odoo_addons19/print_gateway/static/src/scss/print_gateway_backend.scss");
    expect(scss).toContain("font-family: var(--typo-font-stack-latin);");
    expect(scss).toContain("font-family: var(--typo-font-stack-arabic);");
    expect(scss).not.toContain("Avenir Next");

    const manifest = read("odoo_addons19/print_gateway/__manifest__.py");
    expect(manifest).toContain("print_gateway/static/src/css/typography_tokens.css");
    expect(manifest).toContain("print_gateway/static/src/css/typography_fonts.css");
  });

  it("ships the families inside the Odoo module for the server PDF engine", () => {
    const fonts = read("odoo_addons19/print_gateway/static/src/css/typography_fonts.css");
    expect(fonts).toContain("font-display: block");
    expect(fonts).toContain("/print_gateway/static/fonts/ibm-plex-sans-arabic-400.ttf");
    for (const weight of ["400", "500", "600", "700"]) {
      expect(fonts).toContain(`font-weight: ${weight};`);
    }
    for (const file of [
      "ibm-plex-sans-variable.ttf",
      "ibm-plex-sans-arabic-400.ttf",
      "ibm-plex-sans-arabic-500.ttf",
      "ibm-plex-sans-arabic-600.ttf",
      "ibm-plex-sans-arabic-700.ttf",
    ]) {
      expect(existsSync(resolve(process.cwd(), "odoo_addons19/print_gateway/static/fonts", file))).toBe(true);
    }
  });

  it("keeps the POS receipt raster geometry and its no-web-font contract", () => {
    const css = read("odoo_addons19/print_gateway/static/src/css/receipt_raster.css");
    // Physical CSS type stays stable while the output canvas uses the
    // selected printer's dots and independent X/Y DPI.
    expect(css).toContain('--pg-receipt-font-family: "DejaVu Sans", Arial, "Segoe UI", sans-serif;');
    expect(css).toContain("--pg-receipt-font-size: 10.5pt;");
    expect(css).toContain("--pg-receipt-line-height: 1.27;");
    expect(css).toContain("font-family: var(--pg-receipt-font-family) !important;");
    expect(css).toContain("font-size: var(--pg-receipt-font-size) !important;");
    expect(css).toContain("line-height: var(--pg-receipt-line-height) !important;");
    // The capture must never start depending on a web font.
    expect(css).not.toContain("IBM Plex");
    expect(css).not.toContain("@font-face");
  });

  it("applies the print scale to printed output in every application", () => {
    const web = read("src/app/globals.css");
    expect(web).toContain("@media print");
    expect(web).toContain("font-size: var(--typo-fs-display);");
    expect(web).toContain("font-size: var(--typo-fs-body);");
    expect(web).toContain("font-weight: var(--typo-weight-bold);");
    expect(web).toContain("padding-top: var(--typo-space-table-row);");
    expect(web).toContain("color: var(--typo-color-secondary);");
  });
});
