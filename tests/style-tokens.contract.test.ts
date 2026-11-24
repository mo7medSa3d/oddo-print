import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Worker A (v8-style) — Design Guide v2.1 token contract for the Gateway.
 *
 * Pins the guide values in the shipped CSS variables (not in a doc): the
 * primary/ink/secondary hexes, the strong semantic palette in both themes
 * (including the dark info solid >= 4.5:1, see D11), the served font
 * stack (v9-font: Thmanyah served from this origin under the project's
 * purchased Thmanyah licence, served IBM Plex kept as fallback),
 * computed contrast spot-checks (>= 4.5:1 for body text),
 * RTL mirroring rules, and Latin digits under Arabic.
 *
 * Deliberate scope: since v10-exact the shared typography/tokens.css
 * itself leads both stacks with Thmanyah (byte-synced to the Odoo
 * copy, pinned by scripts/check-typography-tokens.py). This test pins
 * the shared file's stacks, not a Gateway-only override (the v9
 * override in globals.css was removed once the canonical file moved).
 */
const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8");
const css = () => read("src/app/globals.css");
const layout = () => read("src/app/layout.tsx");

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("design guide v2.1 token contract (Gateway)", () => {
  it("pins primary #0953DE and ink #101219 in the light theme", () => {
    const g = css();
    expect(g).toContain("--brand: #0953de;");
    expect(g).toContain("--brand-solid: #0953de;");
    expect(g).toContain("--text: #101219;");
    expect(g).toContain("--text-display: #101219;");
    expect(g).not.toContain("--brand: #3758f9;");
  });

  it("pins the secondary palette with dark text on top", () => {
    const g = css();
    expect(g).toContain("--secondary-cyan: #00c7fc;");
    expect(g).toContain("--secondary-yellow: #ffe451;");
    expect(g).toContain("--secondary-pink: #f48cc0;");
    // White on cyan fails (1.99:1); ink on all three secondaries passes.
    expect(ratio("#101219", "#00c7fc")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("#101219", "#ffe451")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("#101219", "#f48cc0")).toBeGreaterThanOrEqual(4.5);
  });

  it("pins the strong semantic palette, light and dark", () => {
    const g = css();
    for (const token of [
      "--success: #145a32;", "--success-bg: #cdeed6;", "--success-border: #2e7d4f;",
      "--warning: #7a4a00;", "--warning-bg: #ffe9a8;", "--warning-border: #b77900;",
      "--danger: #b42318;", "--danger-bg: #fde3e0;", "--danger-border: #d6453a;",
      "--info: #0f6b7e;", "--info-bg: #ddf3f7;", "--info-border: #2aa5b8;",
      "--success: #7ed492;", "--warning: #f5c86b;", "--danger: #ff9a8a;", "--info: #7ed4e3;",
      // Dark info solid: #2f6fbf (white 5.06:1) — the previous #3d7dcc
      // measured 4.20:1, below the 4.5:1 bar (Worker B conflict, resolved).
      "--info-solid: #2f6fbf;",
    ]) {
      expect(g).toContain(token);
    }
    // Info is teal, distinct from primary blue #0953DE.
    expect(g).toContain("--info: #0f6b7e;");
  });

  it("passes computed contrast spot-checks for main text/background pairs", () => {
    const pairs: Array<[string, string, string]> = [
      ["white on primary", "#ffffff", "#0953de"],
      ["ink on white", "#101219", "#ffffff"],
      ["text-2 on white", "#3d4457", "#ffffff"],
      ["text-3 on white", "#5a6376", "#ffffff"],
      ["success on its bg", "#145a32", "#cdeed6"],
      ["warning on its bg", "#7a4a00", "#ffe9a8"],
      ["error on its bg", "#b42318", "#fde3e0"],
      ["info on its bg", "#0f6b7e", "#ddf3f7"],
      ["dark ink on dark surface", "#f3f4f6", "#121417"],
      ["dark brand link on dark surface", "#8dbbff", "#121417"],
      ["dark success on its bg", "#7ed492", "#0f2e1c"],
      ["dark warning on its bg", "#f5c86b", "#2a1e05"],
      ["dark error on its bg", "#ff9a8a", "#2b1513"],
      ["dark info on its bg", "#7ed4e3", "#0a242b"],
    ];
    for (const [name, fg, bg] of pairs) {
      expect(ratio(fg, bg), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("serves Thmanyah first with IBM Plex kept as fallback (v9-font)", () => {
    // v9-font: Thmanyah Sans is served from this origin via
    // next/font/local under --font-thmanyah, under the project's
    // purchased Thmanyah licence; OFL-licensed IBM Plex stays behind it
    // as the fallback if Thmanyah fails to load. The old "no shipped
    // Thmanyah files" state is gone by design — every assertion below
    // pins the new state instead of deleting the coverage.
    expect(existsSync(resolve(process.cwd(), "src/app/fonts/thmanyah"))).toBe(true);
    const l = layout();
    expect(l).toContain('from "next/font/local"');
    expect(l).toContain("ibm-plex-sans-variable.woff2");
    expect(l).toContain('variable: "--font-ibm-plex-sans"');
    expect(l).toContain('variable: "--font-ibm-plex-sans-arabic"');
    expect(l).toContain('variable: "--font-thmanyah"');
    for (const file of [
      "thmanyahsans-Light.woff2",
      "thmanyahsans-Regular.woff2",
      "thmanyahsans-Medium.woff2",
      "thmanyahsans-Bold.woff2",
      "thmanyahsans-Black.woff2",
    ]) {
      expect(l).toContain(`fonts/thmanyah/${file}`);
      expect(existsSync(resolve(process.cwd(), `src/app/fonts/thmanyah/${file}`))).toBe(true);
    }
    const g = css();
    expect(g).not.toContain("prohibits web embedding");
    // The Thmanyah-first stacks now live in the shared spec itself
    // (v10-exact moved them there from the old globals.css override),
    // byte-synced to the Odoo copy — pin them there, in both files.
    const tokens = read("typography/tokens.css");
    const odooTokens = read("odoo_addons/print_gateway/static/src/css/typography_tokens.css");
    for (const t of [tokens, odooTokens]) {
      expect(t).toContain('--typo-font-latin: var(--font-thmanyah, "Thmanyah Sans"), var(--font-ibm-plex-sans, "IBM Plex Sans");');
      expect(t).toContain('--typo-font-arabic: var(--font-thmanyah, "Thmanyah Sans"), var(--font-ibm-plex-sans-arabic, "IBM Plex Sans Arabic");');
    }
    expect(tokens).toBe(odooTokens);
    // No external font CDN for product UI.
    expect(g).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    // (The layout comment names next/font/google as the rejected
    // alternative; assert the import itself, not the comment.)
    expect(l).not.toContain('from "next/font/google"');
    expect(l).not.toContain("fonts.googleapis.com");
    // Dark info solid must clear the 4.5:1 bar for white text on it.
    expect(ratio("#ffffff", "#2f6fbf")).toBeGreaterThanOrEqual(4.5);
    // Documented deviation with proof (v10-exact): the guide's earlier
    // dark-info value #3D7DCC measures 4.20:1 for white text — below
    // the 4.5:1 bar — so #2F6FBF (5.06:1) is kept instead. If the guide
    // value ever changes, this assertion names the failing value.
    expect(ratio("#ffffff", "#3d7dcc")).toBeLessThan(4.5);
  });

  it("keeps IBM Plex files on disk (the typography gate still requires them)", () => {
    // Grep proof for the decision in STYLE.md: the shared typography gate
    // requires the web IBM files to exist and match the Odoo copies.
    const gate = read("scripts/check-typography-tokens.py");
    expect(gate).toContain("ibm-plex-sans-variable.ttf");
    for (const file of ["ibm-plex-sans-variable.ttf", "ibm-plex-sans-arabic-400.ttf"]) {
      expect(existsSync(resolve(process.cwd(), `src/app/fonts/${file}`))).toBe(true);
    }
  });

  it("mirrors prev/next arrows with language but never flips logos", () => {
    const shell = read("src/components/AppShell.tsx");
    expect(shell).toContain("rtl:-scale-x-100"); // collapse/expand arrows
    const brand = read("src/components/brand.tsx");
    expect(brand).not.toContain("rtl:-scale-x");
    expect(brand).not.toContain("-scale-x-100");
    // Logos are never recoloured: brand artwork keeps its file colours.
    expect(brand).toContain("/brand/print-gateway-en.svg");
    expect(brand).toContain("/brand/print-gateway-ar.svg");
  });

  it("keeps Latin digits under Arabic (Intl forced to latn)", async () => {
    const { intlLocale } = await import("../src/i18n/config");
    expect(intlLocale("ar")).toBe("ar-u-nu-latn");
    const { formatNumber } = await import("../src/i18n/format");
    // Grouping separator is fine; the digits themselves must be Latin.
    expect(formatNumber(2026, "ar").replace(/,/g, "")).toBe("2026");
    expect(formatNumber(2026, "ar")).not.toMatch(/[٠-٩]/);
    const ar = read("src/i18n/messages/ar.ts");
    expect(ar).not.toMatch(/[٠-٩]/);
  });

  it("uses pill buttons, 12px fields, 44px standard height and a 3px focus ring", () => {
    const ui = read("src/components/ui.tsx");
    expect(ui).toContain("rounded-full");
    expect(ui).toContain("min-h-11 px-6");
    expect(ui).toContain("min-h-12 px-6");
    expect(ui).toContain("rounded-md border border-control");
    expect(ui).toContain("ring-[3px]");
    expect(ui).toContain("ring-offset-[3px]");
    expect(ui).toContain('t("common.required")');
    expect(ui).toContain("focusFirstError");
    expect(ui).toContain("useUnsavedChangesWarning");
    const g = css();
    expect(g).toContain("outline: 3px solid var(--focus-ring);");
    expect(g).toContain("outline-offset: 3px;");
    expect(g).toContain("--sidebar-width: 17rem;");
  });

  it("never renders status by colour alone in the shared badge", () => {
    const ui = read("src/components/ui.tsx");
    // StatusBadge always pairs the tone with a dot/icon AND a text label.
    expect(ui).toContain("StatusDot");
    expect(ui).toContain("{label}");
  });
});
