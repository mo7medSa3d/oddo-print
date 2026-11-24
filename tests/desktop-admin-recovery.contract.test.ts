import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("desktop administrator recovery and Windows startup UX", () => {
  it("enforces Administrator-only usage with a locked SaaS gate, backend guard, and elevated relaunch", () => {
    const commands = read("src-tauri/src/commands.rs");
    const mainRust = read("src-tauri/src/main.rs");
    const ipc = read("src/desktop/lib/ipc.ts");
    const desktop = read("src/desktop/main.tsx");

    expect(commands).toContain("const TOKEN_ELEVATION: DWORD = 20;");
    expect(commands).toContain("fn require_admin() -> Result<(), String>");
    expect(commands).toContain("pub fn relaunch_as_admin(app: tauri::AppHandle)");
    expect(commands).toContain("pub fn close_app(app: tauri::AppHandle)");
    expect(commands).toContain("ShellExecuteW");
    expect(commands).toContain('OsStr::new("runas")');
    expect(commands).toContain("--elevated-relaunch");
    expect(mainRust).toContain("commands::relaunch_as_admin");
    expect(mainRust).toContain("commands::close_app");
    expect(mainRust).toContain("acquire_single_instance(elevated_relaunch)");
    expect(desktop).toContain("if (isTauri && isAdmin === false)");
    expect(desktop).toContain("desktop.adminGate.relaunch");
    expect(desktop).toContain("desktop.adminGate.close");
    expect(ipc).toContain("relaunch_as_admin");
    expect(ipc).toContain("close_app");
  });

  it("gives an elevated stopped Agent a recovery action", () => {
    const desktop = read("src/desktop/main.tsx");
    expect(desktop).toContain("agentStartupGraceElapsed");
    expect(desktop).toContain('t("desktop.app.agentNeedsStartTitle")');
    expect(desktop).toContain('t("desktop.app.startAgentNow")');
    expect(desktop).not.toContain("setAdminDismissed");
  });

  it("suppresses every bounded Windows helper console window", () => {
    const agent = read("src-tauri/src/agent.rs");
    const paths = read("src-tauri/src/paths.rs");
    const boundedStart = agent.indexOf("pub(crate) fn run_bounded_command");
    const bounded = agent.slice(boundedStart, boundedStart + 1800);
    expect(bounded).toContain("CREATE_NO_WINDOW");
    expect(bounded).toContain("cmd.creation_flags(CREATE_NO_WINDOW)");
    expect(paths).toContain("crate::agent::run_bounded_command");
    expect(paths).toContain('windows_system32_exe("icacls.exe")');
  });

  it("repairs a missing Agent service only through the privileged service path", () => {
    const agent = read("src-tauri/src/agent.rs");
    const mainRust = read("src-tauri/src/main.rs");
    const helperStart = agent.indexOf("fn ensure_service_installed");
    const helper = agent.slice(helperStart, helperStart + 2200);
    expect(helper).toContain("sc_query()?.is_some()");
    expect(helper).toContain('run_agent_service_command(app, "install", COMMAND_TIMEOUT)');
    expect(agent).toContain("ensure_service_installed(app)?");
    expect(mainRust).toContain("!commands::is_running_as_admin()");
    expect(mainRust).toContain("deferring Agent service repair/start until Administrator relaunch");
  });
});
