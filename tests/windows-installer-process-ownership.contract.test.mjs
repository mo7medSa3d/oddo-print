import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const nsis = fs.readFileSync("src-tauri/installer_hooks.nsh", "utf8");
const agent = fs.readFileSync("src-tauri/src/agent.rs", "utf8");

test("NSIS uninstall never terminates processes by image name", () => {
  assert.doesNotMatch(nsis, /taskkill\.exe/i);
  assert.doesNotMatch(nsis, /\/IM\s+/i);
  assert.match(nsis, /YASEIR_STOP_OWNED_SERVICE_VERIFY/);
  assert.match(nsis, /BINARY_PATH_NAME/);
  assert.match(nsis, /-service purge/);
});

test("Manager forced termination is exact-PID and ownership fenced", () => {
  assert.match(agent, /fn background_record_matches\(/);
  assert.match(agent, /process_images_match\(&actual, &expected\)/);
  assert.match(agent, /creation_time == record\.creation_time/);
  assert.match(agent, /fn taskkill_pid\(pid: u32, force: bool\)/);
  assert.match(agent, /cmd\.args\(\["\/PID", &pid_arg, "\/T", "\/F"\]\)/);
  assert.doesNotMatch(agent, /\.args\(\["\/IM"/);
});
