import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const model = await readFile('src/lib/printer-model.ts', 'utf8');
const start = model.indexOf('export function discoveryIppUriMatchesEndpoint(');
const end = model.indexOf('function validatePrivatePrinterHost(', start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({URL, Number});
const parsed = new vm.SourceTextModule(stripTypeScriptTypes(model.slice(start,end),{mode:'transform'}),{context});
await parsed.link(()=>{throw Error('Unexpected import in discovery helper');});
await parsed.evaluate();
const match = parsed.namespace.discoveryIppUriMatchesEndpoint;
const routeSource = await readFile('src/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route.ts','utf8');

test('IPP provisioning agrees with the exact approved network endpoint including IPv6',()=>{
  assert.equal(match('ipp://192.168.8.34:631/ipp/print','192.168.8.34',631,'ipp'),true);
  assert.equal(match('ipps://192.168.8.34/ipp/print','192.168.8.34',631,'ipps'),true);
  assert.equal(match('https://[fd12:3456::10]:631/ipp/print','fd12:3456::10',631,'ipps'),true);
  assert.equal(match('ipp://192.168.8.35:631/ipp/print','192.168.8.34',631,'ipp'),false);
  assert.equal(match('ipp://192.168.8.34:9100/ipp/print','192.168.8.34',631,'ipp'),false);
  assert.equal(match('http://192.168.8.34:631/ipp/print','192.168.8.34',631,'ipps'),false);
  assert.equal(match('ipp://user:password@192.168.8.34:631/ipp/print','192.168.8.34',631,'ipp'),false);
});

test('manager provisioning checks observed IPP address before matching or inserting a printer',()=>{
  const check = routeSource.indexOf('!discoveryIppUriMatchesEndpoint(device.uri');
  const find = routeSource.indexOf('const expectedIppAddress = device.uri');
  const insert = routeSource.indexOf('await tx.insert(printers)');
  assert.ok(check > 0 && find > check && insert > find);
});
