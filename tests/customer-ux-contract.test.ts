import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("customer-facing UX contracts", () => {
  it("keeps System Health focused on customer-actionable services", () => {
    const page = read("src/app/system-health/system-health-client.tsx");
    expect(page).toContain("const customerChecks = [health.gateway, health.agents, health.printers, health.odoo]");
    expect(page).toContain("const visibleOverall = customerOverall(customerChecks)");
    expect(page).not.toContain('label="X-Request-Id"');
    expect(page).not.toContain('t("health.tracing")');
    expect(page).not.toContain("JSON.stringify(check.details");
    expect(page).not.toContain("check.latencyMs");
  });

  it("uses the IBM Plex bilingual font system in the web console", () => {
    const layout = read("src/app/layout.tsx");
    const css = read("src/app/globals.css");
    expect(layout).toContain("IBM_Plex_Sans");
    expect(layout).toContain("IBM_Plex_Sans_Arabic");
    expect(css).toContain("--font-ibm-plex-sans");
    expect(css).toContain("--font-ibm-plex-sans-arabic");
    expect(css).toContain('html[dir="rtl"] body');
  });

  it("keeps language and job menus above bottom-edge triggers", () => {
    const language = read("src/components/LanguageSwitcher.tsx");
    const shell = read("src/components/AppShell.tsx");
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    const ui = read("src/components/ui.tsx");
    expect(language).toContain('placement = "above"');
    expect(shell).toContain('<LanguageSwitcher align="start" placement="above"');
    expect((dashboard.match(/items=\{jobActions\(job\)\}[\s\S]{0,180}?placement="above"/g) ?? []).length).toBe(2);
    expect(ui).toContain("window.visualViewport");
    expect(ui).toContain("viewportBottom");
    expect(ui).toContain("createPortal(");
    expect(ui).toContain('position: "fixed"');
  });

  it("validates Gateway domains through a stable public Yaseir probe", () => {
    const route = read("src/app/api/agent/probe/route.ts");
    const desktop = read("src/desktop/lib/ipc.ts");
    const rust = read("src-tauri/src/commands.rs");
    expect(route).toContain('service: "yaseir-print-gateway"');
    expect(desktop).toContain("/api/agent/probe");
    expect(desktop).toContain('data.service !== "yaseir-print-gateway"');
    expect(desktop).toContain("https://");
    expect(rust).toContain('.join("api/agent/probe")');
    expect(rust).toContain('format!("https://{url}")');
    expect(rust).toContain('is_public_gateway_path("/api/agent/probe")');
  });
});
