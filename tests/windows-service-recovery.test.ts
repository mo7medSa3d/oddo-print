import { describe, it, expect } from "vitest";
import * as fs from "fs";

describe("windows-service-recovery", () => {
  it("service recovery config matches the real agent/toolchain registration", () => {
    const doc = fs.readFileSync("docs/WINDOWS_SERVICE_RECOVERY.md", "utf8");
    expect(doc).toContain("YaseirAgent");
    expect(doc).toContain("86400");
    expect(doc).toContain("restart/60000");
    expect(doc).toContain("Spooler");
    expect(doc).toContain("Service Control Manager");
    // The documented service identity must match the code that actually
    // registers the service, or sc query/qfailure instructions fail on a
    // real Windows host.
    const mainGo = fs.readFileSync("agent/cmd/agent/main.go", "utf8");
    expect(mainGo).toContain('Name:         "YaseirAgent"');
    expect(mainGo).toContain('"actions= restart/60000/restart/60000/restart/60000"');
  });


  it("desktop manager is single-instance and refocuses the existing window", () => {
    const main = fs.readFileSync("src-tauri/src/main.rs", "utf8");
    expect(main).toContain("CreateMutexW");
    expect(main).toContain("YaseirPrintManager.SingleInstance.v1");
    expect(main).toContain("ERROR_ALREADY_EXISTS");
    expect(main).toContain("focus_existing_manager_window");
    expect(main).toContain("SetForegroundWindow");
    expect(main).toContain("Ok(None) => return");
  });

  it("Windows uninstall removes service, product processes, and runtime data", () => {
    const nsis = fs.readFileSync("src-tauri/installer_hooks.nsh", "utf8");
    const wix = fs.readFileSync("src-tauri/wix/service.wxs", "utf8");
    const agentMain = fs.readFileSync("agent/cmd/agent/main.go", "utf8");
    const windowsInstall = fs.readFileSync("agent/cmd/agent/service_install_windows.go", "utf8");

    expect(nsis).toContain('taskkill /F /T /IM "Yaseir Print Manager.exe"');
    expect(nsis).toContain("taskkill /F /T /IM YaseirAgent.exe");
    expect(nsis).toContain("-service purge");
    expect(nsis).toContain("RMDir /r \"$LOCALAPPDATA\\YaseirManager\"");

    const tauriConf = fs.readFileSync("src-tauri/tauri.conf.json", "utf8");
    expect(wix).toContain('ComponentGroup Id="YaseirServiceLifecycle"');
    expect(wix).toContain('Component Id="YaseirServiceLifecycleAnchor"');
    expect(tauriConf).toContain('"componentGroupRefs"');
    expect(tauriConf).toContain('"YaseirServiceLifecycle"');

    expect(wix).toContain('Id="YaseirKillManagerProcesses"');
    expect(wix).toContain('Id="YaseirKillAgentProcesses"');
    expect(wix).toContain("-service purge");
    expect(wix).toContain('Before="RemoveFiles"');

    expect(agentMain).toContain('case "uninstall":');
    expect(agentMain).toContain('case "purge":');
    expect(agentMain).toContain("stopServiceForRemoval");
    expect(agentMain).toContain("purgeAgentData()");
    expect(agentMain).toContain("purgeInstallationData()");
    expect(agentMain).toContain("acquireAgentRuntimeSingleton");
    expect(fs.readFileSync("agent/cmd/agent/runtime_singleton_windows.go", "utf8")).toContain(
      "Global\\YaseirAgent.Runtime.Singleton.v1",
    );
    expect(fs.readFileSync("src-tauri/src/agent.rs", "utf8")).toContain(
      "exited during startup with status",
    );
    for (const dir of [
      "YaseirAgent",
      "YasserAgent",
      "OdooPrintAgent",
      "YaseirManager",
      "YasserManager",
      "OdooPrintManager",
      "Odoo Print Manager",
      "com.yasser.manager",
    ]) {
      expect(windowsInstall).toContain(`"${dir}"`);
    }
    expect(windowsInstall).toContain('filepath.Join(systemDrive+string(os.PathSeparator), "Users")');
    expect(windowsInstall).toContain('filepath.Join(profile, "AppData", "Local")');
    expect(windowsInstall).toContain('filepath.Join(profile, "AppData", "Roaming")');
    expect(windowsInstall).toContain('"OdooPrintManager"');
    expect(windowsInstall).toContain('"Odoo Print Manager"');
    expect(windowsInstall).toContain("purgeAutostartRegistry");
    expect(windowsInstall).toContain("registry.USERS");
    expect(windowsInstall).toContain("func purgeLegacyAgentServices()");
    expect(windowsInstall).toContain('"YasserAgent"');
    expect(windowsInstall).toContain('"OdooPrintAgent"');
    expect(windowsInstall).toContain("manager.OpenService(name)");
    expect(windowsInstall).toContain("existing.Delete()");
    expect(agentMain).toContain("purgeLegacyAgentServices()");
    expect(agentMain.match(/purgeLegacyAgentServices\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("desktop Agent start never spawns a fallback while the Windows service exists", () => {
    const source = fs.readFileSync("src-tauri/src/agent.rs", "utf8");
    const start = source.slice(source.indexOf("fn start_inner"), source.indexOf("pub fn stop("));
    expect(start).toContain("match sc_query()?");
    expect(start).toContain("Some(4) => Ok(())");
    expect(start).toContain("Some(1) => { if is_process_running(app) { stop_inner(app)?; } run_net(\"start\")?");
    expect(start).toContain("None =>");
    expect(start).toContain("spawn_background(app)");
    expect(start.indexOf("spawn_background(app)")).toBeGreaterThan(start.indexOf("None =>"));
  });

  it("service status API returns BLOCKED explicit with required fields", () => {
    const source = fs.readFileSync("src/app/api/agents/service-status/route.ts", "utf8");
    expect(source).toContain("serviceName");
    expect(source).toContain('serviceName: "YaseirAgent"');
    expect(source).toContain("state");
    expect(source).toContain("startType");
    expect(source).toContain("recovery");
    expect(source).toContain("lastRestart");
    expect(source).toContain("failureCount");
    expect(source).toContain("failureCount: null");
    expect(source).toContain("exitCode: null");
    expect(source).toContain("exitCode");
    expect(source).toContain("BLOCKED");
    expect(source).toContain("Windows Service Control Manager");
    expect(source).not.toContain("YaseirPrintAgent");
    expect(source).not.toContain("YasserPrintAgent");
  });

  it("kill→SCM restart→reconnect test procedure documented", () => {
    const doc = fs.readFileSync("docs/WINDOWS_SERVICE_RECOVERY.md", "utf8");
    expect(doc).toContain("sc start");
    expect(doc).toContain("taskkill");
    expect(doc).toContain("sc query");
    expect(doc).toContain("failure count");
    expect(doc).toContain("Gateway");
    expect(doc).toContain("90s");
  });

  it("Tauri updater claims verified — no updater if not implemented", () => {
    // Check tauri.conf.json for updater
    const tauriConfPath = "src-tauri/tauri.conf.json";
    let hasUpdater = false;
    try {
      const conf = fs.readFileSync(tauriConfPath, "utf8");
      hasUpdater = conf.includes("updater") || conf.includes("plugins") && conf.includes("updater");
    } catch {
      hasUpdater = false;
    }
    const cargoPath = "src-tauri/Cargo.toml";
    let cargoHasUpdater = false;
    try {
      const cargo = fs.readFileSync(cargoPath, "utf8");
      cargoHasUpdater = cargo.includes("updater");
    } catch {
      cargoHasUpdater = false;
    }
    // If no updater found, it must be marked BLOCKED/NOT IMPLEMENTED, not claimed PASS
    const releaseReadiness = fs.readFileSync("src/app/release-readiness/release-readiness-client.tsx", "utf8");
    if (!hasUpdater && !cargoHasUpdater) {
      expect(releaseReadiness).toContain('t("release.area.updater")');
      expect(releaseReadiness).toMatch(/BLOCKED|NOT IMPLEMENTED|FAIL/);
    }
  });

  it("BLOCKED handling explicit for sandbox", () => {
    const source = fs.readFileSync("src/app/api/agents/service-status/route.ts", "utf8");
    expect(source).toContain("BLOCKED");
    expect(source).toContain("requires Windows host");
  });
});
