import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("simplified desktop and owner subscription navigation", () => {
  it("removes the redundant Agents view but keeps service actions in Settings", () => {
    const main = read("src/desktop/main.tsx");
    const settings = read("src/desktop/pages/Settings.tsx");
    const pages = read("src/desktop/types.ts");
    const tray = read("src-tauri/src/tray.rs");
    expect(main).not.toContain("AgentsPage");
    expect(main).not.toContain('page === "agents"');
    expect(pages).not.toContain('"agents"');
    expect(settings).toContain("s.startAgent");
    expect(settings).toContain("s.pair");
    expect(settings).not.toContain('navigate("agents")');
    expect(tray).not.toContain("#agents");
  });

  it("routes subscriptions to the workspace page and leaves the Platform Admin login separate", () => {
    const billing = read("src/app/billing/page.tsx");
    const layout = read("src/app/platform/layout.tsx");
    const login = read("src/app/platform/login/page.tsx");
    const appShell = read("src/components/AppShell.tsx");
    expect(billing).toContain("verifyWorkspaceTokenFromCookieValues(");
    expect(billing).not.toContain('redirect("/platform/subscriptions")');
    expect(layout).toContain('encodeURIComponent(pathname)');
    expect(layout).toContain('/platform/login?next=');
    expect(login).toContain('afterLoginDestination()');
    expect(login).toContain('return "/platform/dashboard"');
    expect(appShell).toContain('href: "/billing"');
    expect(appShell).toContain('href: "/team"');
    expect(appShell).not.toContain('href: "/platform/subscriptions"');
  });

  it("retains native Agent pairing and removes repetitive setup fields on the home screen", () => {
    const guide = read("src/desktop/components/SetupGuide.tsx");
    const settings = read("src/desktop/pages/Settings.tsx");
    expect(guide).not.toContain("home-pair-code");
    expect(guide).toContain('s.navigate("settings")');
    expect(settings).toContain('htmlFor="pair-code"');
  });
});
