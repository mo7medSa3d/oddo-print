import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("desktop administrator recovery and Windows startup UX", () => {
  it("wires the Administrator prompt to a real Windows elevation relaunch", () => {
    const commands = read("src-tauri/src/commands.rs");
    const mainRust = read("src-tauri/src/main.rs");
    const ipc = read("src/desktop/lib/ipc.ts");
    const desktop = read("src/desktop/main.tsx");
    const dialog = read("src/desktop/components/AdminPrivilegeDialog.tsx");

    expect(commands).toContain("pub fn relaunch_as_admin()");
    expect(commands).toContain("ShellExecuteW");
    expect(commands).toContain('OsStr::new("runas")');
    expect(commands).toContain("--elevated-relaunch");
    expect(mainRust).toContain("commands::relaunch_as_admin");
    expect(mainRust).toContain("acquire_single_instance(elevated_relaunch)");
    expect(ipc).toContain('invoke<void>("relaunch_as_admin")');
    expect(desktop).toContain("onRelaunch={relaunchAsAdmin}");
    expect(dialog).toContain("await onRelaunch()");
    expect(dialog).toContain('t("desktop.admin.relaunchFailed")');
  });

  it("keeps non-admin guidance visible and gives an elevated stopped Agent a recovery action", () => {
    const desktop = read("src/desktop/main.tsx");
    expect(desktop).toContain("{isAdmin === false && (");
    expect(desktop).toContain("agentStartupGraceElapsed");
    expect(desktop).toContain('t("desktop.app.agentNeedsStartTitle")');
    expect(desktop).toContain('t("desktop.app.startAgentNow")');
    expect(desktop).toContain("if (isAdmin === false) setAdminDismissed(false);");
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

  it("repairs a missing Agent service when an elevated Manager starts", () => {
    const agent = read("src-tauri/src/agent.rs");
    const start = agent.indexOf("pub fn ensure_started");
    const block = agent.slice(start, start + 2200);
    expect(block).toContain("sc_query()?.is_none()");
    expect(block).toContain('run_agent_service_command(app, "install", COMMAND_TIMEOUT)');
    expect(block).toContain("start_inner(app)");
  });
});
