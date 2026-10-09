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
    const windowsInstall = fs.readFileSync("agent/cmd/agent/service_install_windows.go", "utf8");
    expect(mainGo).toContain('Name:         "YaseirAgent"');
    expect(windowsInstall).toContain("existing.SetRecoveryActions(actions, 24*60*60)");
    expect(windowsInstall.match(/mgr.ServiceRestart/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
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

  it("desktop close button exits the manager instead of hiding it in the tray", () => {
    const main = fs.readFileSync("src-tauri/src/main.rs", "utf8");
    const tray = fs.readFileSync("src-tauri/src/tray.rs", "utf8");

    expect(main).toContain("WindowEvent::CloseRequested");
    expect(main).toContain("app_handle.exit(0)");
    expect(main).not.toContain("api.prevent_close()");
    expect(main).not.toContain("handle.hide()");
    expect(tray).toContain('"quit" => app.exit(0)');
  });

  it("Windows uninstall removes services and runtime data without image-wide process kills", () => {
    const nsis = fs.readFileSync("src-tauri/installer_hooks.nsh", "utf8");
    const agentMain = fs.readFileSync("agent/cmd/agent/main.go", "utf8");
    const windowsInstall = fs.readFileSync("agent/cmd/agent/service_install_windows.go", "utf8");

    // Privileged utilities must resolve outside inherited PATH search.
    expect(nsis).not.toMatch(/nsExec::Exec[^'\n]*'net (stop|start)/);
    expect(nsis).not.toMatch(/nsExec::Exec[^'\n]*'sc (stop|start|delete|query)/);
    expect(nsis).not.toMatch(/nsExec::Exec[^'\n]*'taskkill /);
    // Never terminate by image name: a matching filename does not prove the
    // process belongs to this installation. Exact-PID ownership fencing lives
    // in the Manager runtime instead.
    expect(nsis).not.toContain("taskkill.exe");
    expect(nsis).not.toMatch(/\/IM\s+/i);
    // Verified SCM stop precedes service purge and binary removal.
    expect(nsis).toContain("STOPPED");
    expect(nsis).toContain("YASEIR_STOP_OWNED_SERVICE_VERIFY");
    expect(nsis).toContain("BINARY_PATH_NAME");
    expect(nsis).toContain("-service purge");
    expect(nsis).not.toMatch(/RMDir\s+\/r\s+.*LOCALAPPDATA/i);
    expect(nsis).toContain("The Agent owns machine-data removal");

    const tauriConf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(tauriConf.bundle.targets).toEqual(["nsis"]);
    expect(tauriConf.bundle.windows.wix).toBeUndefined();
    expect(nsis).toContain("NSIS_HOOK_PREUNINSTALL");
    expect(nsis).not.toContain('sc.exe" delete YasserAgent');
    expect(nsis).not.toContain('sc.exe" delete OdooPrintAgent');
    expect(nsis).toContain("-service purge");

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
      // Only exact owned directory identities are permitted; names with spaces
      // and unrelated application identifiers must never be recursively purged.
    ]) {
      expect(windowsInstall).toContain(`"${dir}"`);
    }
    expect(windowsInstall).not.toContain('"Odoo Print Manager"');
    expect(windowsInstall).not.toContain('"com.yasser.manager"');
    // Machine cleanup uses trusted ProgramData roots; it must not enumerate
    // profiles or other users' registry hives during elevated uninstall.
    expect(windowsInstall).toContain("trusted ProgramData");
    expect(windowsInstall).toContain("func purgeInstallationData() error");
    expect(windowsInstall).not.toContain("registry.USERS");
    expect(windowsInstall).not.toContain('filepath.Join(profile, "AppData", "Local")');
    expect(windowsInstall).toContain("func purgeLegacyAgentServices()");
    expect(windowsInstall).toContain('"YasserAgent"');
    expect(windowsInstall).toContain('"OdooPrintAgent"');
    expect(windowsInstall).toContain("manager.OpenService(name)");
    expect(windowsInstall).toContain("existing.Delete()");
    expect(agentMain).toContain("purgeLegacyAgentServices()");
    expect(agentMain.match(/purgeLegacyAgentServices\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("desktop Agent start requires the owned Windows service and never silently falls back", () => {
    const source = fs.readFileSync("src-tauri/src/agent.rs", "utf8");
    const start = source.slice(source.indexOf("fn start_inner"), source.indexOf("pub fn stop("));
    expect(start).toContain("match sc_query()?");
    expect(start).toContain("verify_installed_service_ownership(app)?");
    expect(start).toContain('run_agent_service_command(app, "start", COMMAND_TIMEOUT)?');
    expect(start).not.toContain("run_net(");
    expect(start).toContain("None => Err(");
    expect(start).toContain("Reopen Yaseir Print Manager as Administrator");
    expect(start).not.toContain("spawn_background(app)");
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
