import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrace, createTraceAggregator, aggregateTraces, asTable } from "../scripts/print-latency-report.mjs";

test("parses Gateway structured JSON and Agent/Odoo text traces", () => {
  assert.equal(parseTrace('{"event":"print.trace.gateway_enqueue","enqueueLatencyMs":18}').event, "gateway_enqueue");
  assert.equal(parseTrace("2026/10/10 print.trace pdf_worker_wait latency_ms=90 success=true").fields.latency_ms, "90");
  assert.equal(parseTrace("2026-10-10 INFO print.trace odoo_route gateway_submit_ms=45").event, "odoo_route");
  assert.equal(parseTrace("{invalid json"), null);
  assert.equal(parseTrace("not an event"), null);
});

test("tracks only measured positive/zero durations, not secrets or invalid values", () => {
  const lines = [
    '{"event":"print.trace.gateway_enqueue","enqueueLatencyMs":10,"payload":"PRIVATE"}',
    '{"event":"print.trace.gateway_enqueue","enqueueLatencyMs":30}',
    "2026/10/10 print.trace pdf_first_page_render latency_ms=250 printer=secret",
    "2026/10/10 print.trace pdf_worker_wait latency_ms=0",
    "2026/10/10 print.trace pdf_worker_wait latency_ms=-200",
    '{"event":"print.trace.gateway_enqueue","enqueueLatencyMs":"not-a-number"}',
  ];
  const a = createTraceAggregator();
  for (const line of lines) a.addLine(line);
  assert.deepEqual(a.summary(), aggregateTraces(lines));
  const result = a.summary();
  assert.deepEqual(result.metrics["gateway.enqueue"], {count:2,p50_ms:10,p95_ms:30,max_ms:30});
  assert.equal(result.metrics["windows.pdf_first_page_render"].p50_ms,250);
  assert.equal(result.metrics["windows.pdf_worker_wait"].count,1);
  assert.ok(!asTable(result).includes("PRIVATE"));
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("CLI processes multiple local files without exposing raw job identifiers or documents", () => {
  const dir=mkdtempSync(join(tmpdir(),"yaseir-latency-"));
  try {
    const a=join(dir,"gateway.log"), b=join(dir,"agent.log");
    writeFileSync(a, '{"event":"print.trace.gateway_enqueue","enqueueLatencyMs":11,"payload":"PRIVATE"}\n');
    writeFileSync(b, "2026/10/10 print.trace pdf_pipeline job_id=SECRET latency_ms=900 success=true\n");
    const script=fileURLToPath(new URL("../scripts/print-latency-report.mjs",import.meta.url));
    const run=spawnSync(process.execPath,[script,"--json",a,b],{encoding:"utf8"});
    assert.equal(run.status,0,run.stderr);
    const result=JSON.parse(run.stdout);
    assert.equal(result.metrics["gateway.enqueue"].p95_ms,11);
    assert.equal(result.metrics["windows.pdf_total"].p95_ms,900);
    assert.ok(!run.stdout.includes("SECRET"));
    assert.ok(!run.stdout.includes("PRIVATE"));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
