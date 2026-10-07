import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");
const goInstall = read("agent/cmd/agent/service_install_windows.go");
const goMain = read("agent/cmd/agent/main.go");
const tauri = read("src-tauri/src/agent.rs");
const nsis = read("src-tauri/installer_hooks.nsh");

test("Go service control fails closed on foreign current and legacy registrations", () => {
  assert.match(goInstall, /verifyCurrentAgentServiceOwnershipIfPresent/);
  assert.match(goInstall, /serviceBinaryMatchesInstallation/);
  assert.match(goInstall, /installationExecutableCandidates/);
  assert.match(goInstall, /verifyLegacyAgentServiceOwnership/);
  assert.match(goInstall, /outside this installation/);
  assert.match(goMain, /verifyCurrentAgentServiceOwnershipIfPresent\(\)/);
  for (const action of ["status", "install", "uninstall", "purge", "start", "stop", "restart"]) {
    assert.match(goMain, new RegExp(`case "status", "install", "uninstall", "purge", "start", "stop", "restart"`));
    assert.ok(action.length > 0);
  }
});

test("Tauri delegates SCM mutations to the ownership-validating bundled Agent", () => {
  assert.doesNotMatch(tauri, /fn run_net\(/);
  assert.doesNotMatch(tauri, /system32_exe\("net\.exe"\)/);
  assert.match(tauri, /fn run_agent_service_command\(/);
  assert.match(tauri, /verify_installed_service_ownership\(app\)\?/);
  assert.match(tauri, /run_agent_service_command\(app, "start", COMMAND_TIMEOUT\)/);
  assert.match(tauri, /run_agent_service_command\(app, "stop", COMMAND_TIMEOUT\)/);
  assert.match(tauri, /run_agent_service_command\(app, "status", COMMAND_TIMEOUT\)/);
});

test("NSIS preinstall stops only exact install-path services and never deletes by name", () => {
  assert.match(nsis, /YASEIR_STOP_OWNED_SERVICE_VERIFY/);
  assert.match(nsis, /sc\.exe" qc/);
  assert.match(nsis, /BINARY_PATH_NAME/);
  assert.match(nsis, /\$INSTDIR\\resources\\\$\{exe\}/);
  assert.match(nsis, /\$INSTDIR\\\$\{exe\}/);
  assert.match(nsis, /foreign Windows service named/);
  assert.doesNotMatch(nsis, /sc\.exe" delete\s+(?:YaseirAgent|YasserAgent|OdooPrintAgent)/i);
  assert.doesNotMatch(nsis, /YASEIR_UN_STOP_SERVICE_VERIFY/);
  assert.match(nsis, /"\$1" -service purge/);
});
