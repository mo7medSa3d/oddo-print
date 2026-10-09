import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const nsis = readFileSync('src-tauri/installer_hooks.nsh', 'utf8');
const go = readFileSync('agent/cmd/agent/service_install_windows.go', 'utf8');
const uninstall = nsis.slice(nsis.indexOf('!macro NSIS_HOOK_PREUNINSTALL'));

test('NSIS never repeats privileged recursive deletion after owned Agent purge', () => {
  assert.match(uninstall, /-service purge/);
  assert.doesNotMatch(uninstall, /RMDir\s+\/r/i);
  assert.doesNotMatch(uninstall, /ReadEnvStr\s+\$\d+\s+"PROGRAMDATA"/i);
});

test('Go elevated data purge obtains OS known folders not inherited environment roots', () => {
  const roots = go.slice(go.indexOf('func agentDataRoots()'), go.indexOf('func purgeAgentData()'));
  assert.match(roots, /windows\.KnownFolderPath\(windows\.FOLDERID_ProgramData/);
  assert.doesNotMatch(roots, /os\.Getenv\("PROGRAMDATA"\)|os\.Getenv\("LOCALAPPDATA"\)|os\.Getenv\("APPDATA"\)|os\.Getenv\("SystemDrive"\)/);
  assert.doesNotMatch(roots, /os\.ReadDir\(usersRoot\)/);
});

test('Go purge rejects product-root junctions/reparse points before recursive deletion', () => {
  const purge = go.slice(go.indexOf('func purgePaths('), go.indexOf('func agentDataRoots()'));
  assert.match(purge, /FILE_ATTRIBUTE_REPARSE_POINT/);
  assert.match(purge, /GetFileAttributes/);
  assert.match(purge, /os\.RemoveAll\(root\)/);
});
