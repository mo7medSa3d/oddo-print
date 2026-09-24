import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("Yasser icon asset contract", () => {
  it("uses an Odoo module-root icon path", () => {
    const manifest = read("odoo_addons/print_gateway/__manifest__.py");
    expect(manifest).toContain("'icon': '/print_gateway/static/description/icon.png'");
    expect(manifest).not.toContain("'icon': 'static/description/icon.png'");
  });

  it("keeps the Odoo and desktop PNG assets byte-identical", () => {
    const odoo = readFileSync(join(root, "odoo_addons/print_gateway/static/description/icon.png"));
    const desktop = readFileSync(join(root, "src-tauri/icons/icon.png"));
    expect(odoo.equals(desktop)).toBe(true);
  });

  it("pins the Windows installer and uninstaller to the Yasser ICO", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json")) as {
      bundle?: {
        icon?: string[];
        windows?: { nsis?: { installerIcon?: string; uninstallerIcon?: string } };
      };
    };
    expect(config.bundle?.icon).toContain("icons/icon.ico");
    expect(config.bundle?.windows?.nsis?.installerIcon).toBe("icons/icon.ico");
    expect(config.bundle?.windows?.nsis?.uninstallerIcon).toBe("icons/icon.ico");
  });

  it("keeps the desktop browser icon wired to the same Yasser mark", () => {
    const index = read("src/desktop/index.html");
    const desktopIcon = read("src/desktop/icon.svg");
    expect(index).toContain('rel="icon" type="image/svg+xml" href="./icon.svg"');
    expect(desktopIcon).toContain('fill="#2563EB"');
  });
});
