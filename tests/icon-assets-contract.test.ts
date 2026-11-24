import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("Yaseir icon asset contract", () => {
  it("uses an Odoo module-root icon path", () => {
    const manifest = read("odoo_addons/print_gateway/__manifest__.py");
    expect(manifest).toContain("'icon': '/print_gateway/static/description/icon.png'");
    expect(manifest).not.toContain("'icon': 'static/description/icon.png'");
  });

  it("keeps the Agent assets derived from the canonical Print Agent mark", () => {
    // The icon shown at the bottom of the Desktop Settings page
    // (labelled "Print Agent") is the official Agent icon. Every Agent
    // surface — Tauri bundle PNGs/ICO (exe, taskbar, installer), the
    // tray (via the default window icon) and the Desktop favicon — is
    // generated from it by scripts/generate-agent-icons.mjs.
    const agentMark = readFileSync(join(root, "src/desktop/public/brand/print-agent.svg"));
    const tauriSource = readFileSync(join(root, "src-tauri/icons/icon-source.svg"));
    const desktopIcon = readFileSync(join(root, "src/desktop/icon.svg"));
    expect(tauriSource.equals(agentMark)).toBe(true);
    expect(desktopIcon.equals(agentMark)).toBe(true);
    // The Odoo addon fronts the Gateway, so its PNG keeps the Gateway
    // mark and must NOT be the Agent PNG.
    const odoo = readFileSync(join(root, "odoo_addons/print_gateway/static/description/icon.png"));
    const agentPng = readFileSync(join(root, "src-tauri/icons/icon.png"));
    expect(odoo.equals(agentPng)).toBe(false);
  });

  it("ships a multi-size Agent ICO with 16, 32, 48 and 256 entries", () => {
    const ico = readFileSync(join(root, "src-tauri/icons/icon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const width = ico[entry] === 0 ? 256 : ico[entry];
      const height = ico[entry + 1] === 0 ? 256 : ico[entry + 1];
      expect(width).toBe(height);
      expect(ico.readUInt16LE(entry + 6)).toBe(32); // 32 bpp
      sizes.push(width);
    }
    for (const required of [16, 32, 48, 256]) {
      expect(sizes).toContain(required);
    }
  });

  it("pins the Windows installer and uninstaller to the Yaseir ICO", () => {
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

  it("keeps the desktop browser icon wired to the Print Agent mark", () => {
    const index = read("src/desktop/index.html");
    const desktopIcon = read("src/desktop/icon.svg");
    expect(index).toContain('rel="icon" type="image/svg+xml" href="./icon.svg"');
    // The Desktop app IS the Print Agent app, so its favicon is the
    // Agent mark (the Settings-page artwork), on the same supplied cyan
    // tile family (WP6-BRANDING); the old blue Y glyph is gone.
    expect(desktopIcon).toContain("#00c7fc");
    expect(read("src/components/brand.tsx")).toContain('fill="#00c7fc"');
    expect(desktopIcon).not.toContain("#2563EB");
  });

  it("keeps the Gateway favicon on the Gateway mark, distinct from the Agent mark", () => {
    const appIcon = readFileSync(join(root, "src/app/icon.svg"));
    const brandIcon = readFileSync(join(root, "public/brand/print-gateway-icon.svg"));
    const agentMark = readFileSync(join(root, "src/desktop/public/brand/print-agent.svg"));
    const tauriSource = readFileSync(join(root, "src-tauri/icons/icon-source.svg"));
    // Gateway surfaces keep the Gateway ("ط") mark, untouched.
    expect(appIcon.equals(brandIcon)).toBe(true);
    // The two product marks are different artwork, and the Tauri/Agent
    // source is the Agent one — never the Gateway one.
    expect(appIcon.equals(agentMark)).toBe(false);
    expect(tauriSource.equals(agentMark)).toBe(true);
    expect(tauriSource.equals(appIcon)).toBe(false);
  });

  it("ships sanitized locale lockups with no script, href, or event handlers", () => {
    for (const file of [
      "public/brand/print-gateway-en.svg",
      "public/brand/print-gateway-ar.svg",
      "public/brand/print-gateway-icon.svg",
      "src/desktop/public/brand/print-agent.svg",
    ]) {
      const svg = read(file);
      expect(svg).not.toMatch(/<script/i);
      expect(svg).not.toMatch(/href\s*=/i);
      expect(svg).not.toContain("xmlns:xlink");
      expect(svg).not.toMatch(/\son\w+\s*=/i);
      expect(svg).not.toContain("<text");
    }
    // Locale geometry: EN lockup icon on the left, AR lockup icon on the right.
    expect(read("public/brand/print-gateway-en.svg")).toContain('viewBox="0 0 946.67 246"');
    expect(read("public/brand/print-gateway-ar.svg")).toContain('viewBox="0 0 813.44 245.33"');
  });

  it("resolves every icon path tauri.conf.json references to a real file", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json")) as {
      bundle?: {
        icon?: string[];
        windows?: { nsis?: { installerIcon?: string; uninstallerIcon?: string } };
      };
    };
    const paths = [
      ...(config.bundle?.icon ?? []),
      config.bundle?.windows?.nsis?.installerIcon,
      config.bundle?.windows?.nsis?.uninstallerIcon,
    ].filter((p): p is string => typeof p === "string");
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(() => readFileSync(join(root, "src-tauri", p))).not.toThrow();
    }
  });

  it("renders the locale lockup through the shared BrandMark component", () => {
    const brand = read("src/components/brand.tsx");
    expect(brand).toContain("/brand/print-gateway-en.svg");
    expect(brand).toContain("/brand/print-gateway-ar.svg");
    expect(brand).toContain("brand-lockup-ltr");
    expect(brand).toContain("brand-lockup-rtl");
    expect(brand).not.toContain("YaseirGlyph");
  });
});
