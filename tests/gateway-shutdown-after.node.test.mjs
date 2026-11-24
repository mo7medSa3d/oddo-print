import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const shutdownStart = serverSource.indexOf('function shutdown(signal: string): void {');
const shutdownEnd = serverSource.indexOf('\nprocess.on("SIGTERM"', shutdownStart);
assert.ok(shutdownStart >= 0 && shutdownEnd > shutdownStart, 'extract the actual custom-server shutdown function');
const shutdownSource = stripTypeScriptTypes(serverSource.slice(shutdownStart, shutdownEnd));
const maintenanceSource = stripTypeScriptTypes(serverSource.slice(serverSource.indexOf('function maintenanceTask('), shutdownStart));
const drainTimeout = Number(serverSource.match(/const SHUTDOWN_DRAIN_TIMEOUT_MS = ([\d_]+);/)[1].replaceAll('_', ''));

function shutdownHarness(rejectAfter = false, holdMaintenance = false) {
  const events = [];
  const timers = new Set();
  let completed;
  const completion = new Promise(resolve => { completed = resolve; });
  let releaseMaintenance;
  let nextCompleted;
  const nextCompletion = new Promise(resolve => { nextCompleted = resolve; });
  const later = (callback, milliseconds) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
    timers.add(timer);
    return timer;
  };
  const context = {
    shuttingDown: false,
    housekeepingTimer: null,
    maintenanceTasks: new Set(),
    SHUTDOWN_DRAIN_TIMEOUT_MS: drainTimeout,
    logInfo() {},
    logError() { events.push('shutdown-error'); },
    flushAuthorizationDenials() { events.push('authorization-denials-flushed'); },
    setTimeout: later,
    clearTimeout,
    agentWss: {
      clients: new Set([{ close(code) { events.push(`socket-close-${code}`); } }]),
      async drain() { await new Promise(resolve => later(() => { events.push('websockets-drained'); resolve(); }, 5)); },
    },
    httpServer: { close(callback) { later(() => { events.push('http-drained'); callback(); }, 5); } },
    app: { async close() {
      events.push('next-close-started');
      // Model asynchronous work already accepted by Next's waitUntil hook.
      // Only the real extracted shutdown function decides whether to await it.
      await new Promise(resolve => later(resolve, 40));
      if (rejectAfter) throw new Error('synthetic Next cleanup failure');
      events.push('next-after-completed');
      nextCompleted();
    } },
    pool: { async end() { events.push('pool-ended'); } },
    process: { exit(code) {
      events.push(`exit-${code}`);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      completed(code);
    } },
  };
  if (holdMaintenance) {
    context.maintenanceOperation = () => new Promise(resolve => {
      releaseMaintenance = () => { events.push('maintenance-completed'); resolve(); };
    });
  }
  vm.runInNewContext(`${maintenanceSource}\n${shutdownSource}\n${holdMaintenance ? "maintenanceTask(maintenanceOperation, 'maintenance-error')();" : ''}\nshutdown('SIGTERM');`, context, { filename: 'actual-gateway-shutdown.js' });
  return { events, completion, nextCompletion, releaseMaintenance: () => releaseMaintenance?.() };
}

test('actual Gateway shutdown waits for delayed Next after work before ending the pool and exiting', { timeout: 2000 }, async () => {
  const run = shutdownHarness();
  assert.equal(await run.completion, 0);
  assert.deepEqual(run.events, ['http-drained', 'next-close-started', 'next-after-completed', 'authorization-denials-flushed', 'pool-ended', 'exit-0']);
});

test('Next cleanup rejection fails shutdown instead of claiming a clean exit', { timeout: 2000 }, async () => {
  const run = shutdownHarness(true);
  assert.equal(await run.completion, 1);
  assert.ok(run.events.includes('shutdown-error'));
  assert.equal(run.events.includes('pool-ended'), false);
  assert.equal(run.events.includes('next-after-completed'), false);
});

test('actual Gateway shutdown drains a maintenance transaction before ending PostgreSQL', { timeout: 2000 }, async () => {
  const run = shutdownHarness(false, true);
  try {
    await run.nextCompletion;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(run.events.includes('pool-ended'), false, 'an accepted maintenance task still needs PostgreSQL');
  } finally {
    run.releaseMaintenance();
  }
  assert.equal(await run.completion, 0);
  assert.ok(run.events.indexOf('maintenance-completed') < run.events.indexOf('pool-ended'));
});

test('process and Compose drain budgets cover bounded three-attempt mail delivery', () => {
  assert.ok(drainTimeout >= 45_000, 'application drain must allow three 10-second attempts and bounded retry delays');
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const gateway = compose.split('\n  gateway:\n')[1].split('\n  caddy:\n')[0];
  const graceSeconds = Number(gateway.match(/^    stop_grace_period: (\d+)s$/m)?.[1]);
  assert.ok(graceSeconds >= 60 && graceSeconds * 1000 > drainTimeout, 'container stop deadline must exceed the application drain deadline');
});
