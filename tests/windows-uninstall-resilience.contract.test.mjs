import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const main = fs.readFileSync("agent/cmd/agent/main.go", "utf8");
const windows = fs.readFileSync("agent/cmd/agent/service_install_windows.go", "utf8");
const nsis = fs.readFileSync("src-tauri/installer_hooks.nsh", "utf8");

function between(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing source range: ${start} .. ${end}`);
  return source.slice(a, b);
}

test("NSIS purge keeps service ownership/removal fatal but data cleanup nonfatal", () => {
  const purge = between(main, 'case "purge":', 'case "start":');
  assert.match(purge, /stopServiceForRemoval\(s\).*return err/s);
  assert.match(purge, /uninstallServiceIfPresent\(s\).*return err/s);
  assert.match(purge, /purgeLegacyAgentServices\(\).*return fmt\.Errorf/s);
  assert.match(purge, /purgeInstallationData\(\).*WARNING: uninstall data cleanup incomplete/s);
  assert.doesNotMatch(purge, /purgeInstallationData\(\); err != nil \{\s*return err/s);
});

test("service deletion retry is idempotent for Windows marked-for-delete state", () => {
  assert.match(windows, /ERROR_SERVICE_MARKED_FOR_DELETE/);
  assert.match(windows, /func serviceRemovalAlreadyComplete\(/);
  assert.match(main, /serviceRemovalAlreadyComplete\(err\)/);
  assert.match(main, /serviceRemovalAlreadyComplete\(statusErr\)/);
});

test("uninstaller leaves residual cleanup to owner-fenced Agent helper", () => {
  const cleanup = between(nsis, "agent_removed:", "!macroend");
  assert.match(cleanup, /secure cleanup runbook/);
  assert.doesNotMatch(cleanup, /RMDir\s+\/r|ReadEnvStr|DeleteRegValue/i);
  assert.doesNotMatch(cleanup, /Abort "Yaseir cleanup failed/);
});
