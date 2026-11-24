import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const pinnedOdooLabel = /\bOdoo[\s\u00a0_-]*(?:v(?:ersion)?[\s_-]*)?19\b|[أا]ودوو?[\s\u00a0_-]*(?:19|١٩)/iu;

function sourceFiles(folder: string): string[] {
  return readdirSync(resolve(root, folder), { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:ts|tsx|js|jsx|json)$/.test(entry.name) ? [path] : [];
  });
}

describe("Odoo version-neutral customer copy", () => {
  it("does not advertise Odoo 19 as the only product integration in Gateway screens or translations", () => {
    const paths = ["src/app", "src/components", "src/i18n/messages"].flatMap(sourceFiles);
    const offending = paths.flatMap(path =>
      read(path).split("\n").flatMap((line, index) =>
        pinnedOdooLabel.test(line) ? [relative(root, resolve(root, path)) + ":" + (index + 1)] : []));
    expect(offending).toEqual([]);
    expect(read("src/app/page.tsx")).toContain('t("home.quickOdooTitle")');
  });

  it("uses unversioned Odoo help labels in the addon and its Arabic translation catalog", () => {
    const model = read("odoo_addons/print_gateway/models/binding.py");
    const view = read("odoo_addons/print_gateway/views/binding_views.xml");
    const catalog = read("odoo_addons/print_gateway/i18n/ar.po");
    expect(model).not.toMatch(/help="[^"]*Odoo 19/);
    expect(view).not.toMatch(/help="[^"]*Odoo 19/);
    expect(catalog).not.toMatch(pinnedOdooLabel);
    expect(catalog).toContain('msgid "Odoo Preparation Printer.');
    expect(catalog).toContain('msgid "Native Odoo preparation-printer identity.');
  });

  it("preserves the Odoo addon technical version until Odoo 20 support is implemented and tested", () => {
    const manifest = read("odoo_addons/print_gateway/__manifest__.py");
    expect(manifest).toMatch(/'version': '19\.0\.\d+\.\d+\.\d+'/);
  });
});
