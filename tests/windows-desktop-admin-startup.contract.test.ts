import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("Windows desktop Agent startup contract", () => {
  it("never allocates a console for the Manager executable", () => {
    const main = read("src-tauri/src/main.rs");
    expect(main).toContain('#![cfg_attr(windows, windows_subsystem = "windows")]');
    expect(main).not.toContain('cfg_attr(not(debug_assertions), windows_subsystem = "windows")');
  });

  it("defers privileged Agent service repair until Administrator relaunch", () => {
    const main = read("src-tauri/src/main.rs");
    expect(main).toContain('!commands::is_running_as_admin()');
    expect(main).toContain("deferring Agent service repair/start until Administrator relaunch");
  });

  it("requires the Windows service instead of silently launching a fallback Agent", () => {
    const agent = read("src-tauri/src/agent.rs");
    const start = agent.slice(agent.indexOf("fn start_inner"), agent.indexOf("pub fn stop", agent.indexOf("fn start_inner")));
    expect(start).toContain("YaseirAgent Windows service is not installed");
    expect(start).not.toContain("spawn_background(app)");
    expect(agent).toContain("fn ensure_service_installed");
    expect(agent).toContain('run_agent_service_command(app, "install", COMMAND_TIMEOUT)');
  });

  it("classifies a missing or stopped local Agent service and offers elevated recovery", () => {
    const desktop = read("src/desktop/main.tsx");
    const commands = read("src-tauri/src/commands.rs");
    const statusClassifier = read("src-tauri/src/agent_status.rs");
    // The app only ever runs elevated (the native startup gate relaunches
    // a non-elevated launch before any window exists), so recovery for a
    // stopped service is the elevated banner with a start action — there
    // is no Administrator dialog or non-admin guidance state anymore.
    expect(desktop).toContain('isAdmin === true && agentStartupGraceElapsed && serviceState === "stopped"');
    expect(desktop).toContain('t("desktop.app.agentNeedsStartTitle")');
    expect(desktop).toContain('t("desktop.app.startAgentNow")');
    expect(desktop).not.toContain("AdminPrivilegeDialog");
    expect(commands).toContain("crate::agent_status::note_code(running, service_running, &note)");
    expect(commands).toContain("note_code: note_code.into()");
    expect(statusClassifier).toContain('"service_missing"');
    expect(statusClassifier).toContain('"service_stopped"');
    expect(statusClassifier).toContain('"background_running_service_missing"');
  });
});
