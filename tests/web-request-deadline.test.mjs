import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

async function loadFetchHelper(fetchImpl) {
  const source = await readFile('src/lib/fetch-timeout.ts', 'utf8');
  const context = vm.createContext({
    AbortController,
    Error,
    Promise,
    URL,
    clearTimeout,
    fetch: fetchImpl,
    setTimeout,
  });
  const mod = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), { context });
  await mod.link(() => { throw new Error('Unexpected external dependency'); });
  await mod.evaluate();
  return mod.namespace.fetchWithTimeout;
}

function abortAwarePendingFetch(_input, init = {}) {
  return new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });
}

test('bounded browser fetch turns a stalled request into a finite timeout error', async () => {
  const fetchWithTimeout = await loadFetchHelper(abortAwarePendingFetch);
  await assert.rejects(fetchWithTimeout('/stall', {}, 20), /Request timed out after 20ms/);
});

test('bounded browser fetch honors an already-aborted caller signal immediately', async () => {
  const fetchWithTimeout = await loadFetchHelper(abortAwarePendingFetch);
  const caller = new AbortController();
  caller.abort(new Error('caller cancelled'));
  await assert.rejects(fetchWithTimeout('/cancelled', { signal: caller.signal }, 1_000), /caller cancelled/);
});

async function tsxFiles(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await tsxFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

test('client app/components do not bypass the shared request deadline helper', async () => {
  const files = [...await tsxFiles('src/app'), ...await tsxFiles('src/components')];
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (!source.slice(0, 200).includes('use client')) continue;
    if (/(?<![A-Za-z0-9_.])fetch\(/u.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
