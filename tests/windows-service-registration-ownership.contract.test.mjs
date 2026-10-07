import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const nsis = fs.readFileSync("src-tauri/installer_hooks.nsh", "utf8");
const windowsInstall = fs.readFileSync("agent/cmd/agent/service_install_windows.go", "utf8");

test("NSIS gates preinstall service stop on the registered executable path", () => {
  assert.match(nsis, /!macro YASEIR_STOP_OWNED_SERVICE_VERIFY name exe tag/);
  assert.match(nsis, /"\$SYSDIR\\sc\.exe" qc "\$\{name\}"/);
  assert.match(nsis, /\$INSTDIR\\resources\\\$\{exe\}/);
  assert.match(nsis, /\$INSTDIR\\\$\{exe\}/);
  assert.match(nsis, /Service \$\{name\} does not point to this installation; refusing to stop or replace it/);
  assert.match(nsis, /YASEIR_STOP_OWNED_SERVICE_VERIFY "YaseirAgent" "YaseirAgent\.exe"/);
  assert.match(nsis, /YASEIR_STOP_OWNED_SERVICE_VERIFY "YasserAgent" "YasserAgent\.exe"/);
  assert.match(nsis, /YASEIR_STOP_OWNED_SERVICE_VERIFY "OdooPrintAgent" "OdooPrintAgent\.exe"/);
  assert.doesNotMatch(nsis, /sc\.exe" delete/i);
  assert.match(nsis, /"\$1" -service purge/);
});

test("Agent current and legacy service mutations require exact installation paths", () => {
  assert.match(windowsInstall, /func serviceBinaryMatchesInstallation\(/);
  assert.match(windowsInstall, /installationExecutableCandidates\(currentExecutable, expectedBasename string\)/);
  assert.match(windowsInstall, /serviceBinaryMatchesInstallation\(cfg\.BinaryPathName, expected, "YaseirAgent\.exe"\)/);
  assert.match(windowsInstall, /func legacyAgentExecutableCandidates\(expectedBasename string\)/);
  assert.match(windowsInstall, /strings\.EqualFold\(executable, candidate\)/);
  assert.match(windowsInstall, /configured binary is outside this installation/);
  assert.doesNotMatch(windowsInstall, /if !strings\.EqualFold\(filepath\.Base\(executable\), expectedBasename\)/);
});
