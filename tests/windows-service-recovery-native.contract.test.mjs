import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const main = fs.readFileSync("agent/cmd/agent/main.go", "utf8");
const windowsInstall = fs.readFileSync("agent/cmd/agent/service_install_windows.go", "utf8");

test("Agent service recovery uses native SCM API with ownership fencing", () => {
  assert.doesNotMatch(main, /SystemRoot/);
  assert.doesNotMatch(main, /exec\.Command\([^\n]*sc/);
  assert.match(windowsInstall, /func configureServiceRecovery\(serviceName string\)/);
  assert.match(windowsInstall, /serviceBinaryMatchesExact\(cfg\.BinaryPathName, expected\)/);
  assert.match(windowsInstall, /existing\.SetRecoveryActions\(actions, 24\*60\*60\)/);
  assert.equal((windowsInstall.match(/Type: mgr\.ServiceRestart/g) ?? []).length, 3);
  assert.match(windowsInstall, /Delay: 60 \* time\.Second/);
});
