/**
 * Offline behavioral regressions for the production HTTP CSRF predicate and
 * gateway printer capability gate, using their actual TypeScript sources.
 * No server, database, Win32 device or network service is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function productionModule(file, imports = {}) {
  const source = readFileSync(resolve(root, file), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const importActualOrStub = (id) => id in imports ? imports[id] : (
    id.startsWith('node:') ? require(id) : (() => { throw new Error(`${file}: unhandled dependency ${id}`); })()
  );
  new Function('require', 'module', 'exports', js)(importActualOrStub, mod, mod.exports);
  return mod.exports;
}

const runtime = productionModule('src/lib/runtime-secret.ts');
const limits = productionModule('src/lib/request-limits.ts');
const guard = productionModule('src/server/request-guard.ts', {
  '../lib/request-limits': limits,
  '../lib/runtime-secret': runtime,
});
const capability = productionModule('src/lib/printer-capability.ts', {
  '../../contracts/print-payload-contract.json': JSON.parse(readFileSync(resolve(root, 'contracts/print-payload-contract.json'), 'utf8')),
});

function asRequest(originOrReferer, host = 'app.example.com') {
  return {
    method: 'POST',
    headers: { host, cookie: 'mgr_session=ambient', 'sec-fetch-site': 'same-site', ...originOrReferer },
  };
}

test('cookie-authenticated mutations are bound to the configured public scheme + host + port', () => {
  const previousBaseUrl = process.env.APP_BASE_URL;
  const previousFile = process.env.APP_BASE_URL_FILE;
  try {
    delete process.env.APP_BASE_URL_FILE;
    process.env.APP_BASE_URL = 'https://app.example.com';
    assert.equal(guard.isCookieMutationSameOrigin(asRequest({ origin: 'https://app.example.com' })), true);
    assert.equal(guard.isCookieMutationSameOrigin(asRequest({ origin: 'http://app.example.com' })), false);
    assert.equal(guard.isCookieMutationSameOrigin(asRequest({ referer: 'http://app.example.com/payments' })), false);
    assert.equal(guard.isCookieMutationSameOrigin(asRequest({ referer: 'https://app.example.com/payments' })), true);
    assert.equal(guard.isCookieMutationSameOrigin(asRequest({ origin: 'https://app.example.com' }, 'another.example.com')), false);
    assert.equal(guard.isCookieMutationSameOrigin(asRequest({ origin: 'https://app.example.com:8443' })), false);
    assert.equal(guard.isCookieMutationSameOrigin(asRequest({ origin: 'https://app.example.com', 'sec-fetch-site': 'cross-site' })), false);
    assert.equal(guard.isCookieMutationSameOrigin({ method: 'POST', headers: {host: 'app.example.com', authorization: 'Bearer native'} }), true);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousBaseUrl;
    if (previousFile === undefined) delete process.env.APP_BASE_URL_FILE;
    else process.env.APP_BASE_URL_FILE = previousFile;
  }
});

test('a network pipe cannot gain Windows driver capabilities from a spooler label', () => {
  const TCP = { connectionType: 'network', protocol: 'spooler', capabilities: { supported_protocols: ['raw', 'escpos', 'pdf', 'image'] } };
  for (const payload of [
    { type: 'pdf' }, { type: 'image' },
    { type: 'raw', protocol: 'raw' }, { type: 'escpos', protocol: 'escpos' },
  ]) {
    assert.equal(capability.validatePayloadForPrinter(payload, TCP).ok, false, JSON.stringify(payload));
  }
  assert.equal(capability.validatePayloadForPrinter({ type: 'pdf' }, { connectionType: 'spooler', protocol: 'spooler' }).ok, true);
  assert.equal(capability.validatePayloadForPrinter({ type: 'pdf' }, { connectionType: 'usb', protocol: 'spooler' }).ok, true);
  assert.equal(capability.validatePayloadForPrinter({ type: 'pdf' }, { connectionType: 'network', protocol: 'ipp' }).ok, true);
});
