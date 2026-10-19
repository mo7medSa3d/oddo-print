// Executes the actual Gateway address-classification code without node_modules.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); }
catch { ts = require(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'typescript')); }
const filename = 'src/lib/network-address.ts';
const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
  fileName: filename, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = vm.createContext({ BigInt, Number, String, Array });
const builtin = new vm.SyntheticModule(['isIP'], function () { this.setExport('isIP', isIP); }, { context });
const sourceModule = new vm.SourceTextModule(code, { context });
await sourceModule.link((name) => {
  assert.equal(name, 'node:net');
  return builtin;
});
await sourceModule.evaluate();
const valid = sourceModule.namespace.isPrivateNetworkAddress;
test('cloud task credentials and instance metadata never pass the printer IP policy', () => {
  for (const address of ['169.254.169.254', '169.254.170.2', 'fd00:ec2::254',
    'fd00:0ec2:0000:0000:0000:0000:0000:0254', 'FD00:0EC2::0254']) {
    assert.equal(valid(address), false, address);
  }
});
test('legitimate LAN and link-local destinations remain admitted', () => {
  for (const address of ['192.168.1.50', '172.16.1.4', '10.0.0.22',
    '169.254.10.20', 'fd12:3456::1', 'fe80::1234']) {
    assert.equal(valid(address), true, address);
  }
});
test('public, loopback, and malformed addresses remain excluded', () => {
  for (const address of ['8.8.8.8', '127.0.0.1', '0.0.0.0', '::1',
    '2001:4860:4860::8888', 'fe80::abcd%2', 'not a printer']) {
    assert.equal(valid(address), false, address);
  }
});
