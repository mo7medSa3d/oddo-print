#!/usr/bin/env node
// Offline Yaseir print.trace latency analysis. Never export raw job contents,
// identifiers, payloads, auth headers, or potentially sensitive printer names.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Each timing uses the local process monotonic clock. Some stages overlap;
// never add stage percentiles to claim total latency or physical paper output.
export const FIELDS = Object.freeze({
  odoo_route: { persist_ms: "odoo.persist", gateway_submit_ms: "odoo.gateway_submit", total_ms: "odoo.route_total" },
  gateway_enqueue: { enqueueLatencyMs: "gateway.enqueue" },
  gateway_claim: { claimLatencyMs: "gateway.claim" },
  gateway_delivery: { claimLatencyMs: "gateway.claim", sendLatencyMs: "gateway.websocket_send", evidenceLatencyMs: "gateway.delivery_evidence", totalLatencyMs: "gateway.delivery_total" },
  gateway_send: { claimLatencyMs: "gateway.claim", sendLatencyMs: "gateway.websocket_send", totalLatencyMs: "gateway.delivery_total" },
  agent_receive: { queue_wait_ms: "agent.dispatch_wait" },
  local_ledger_ready: { ledger_latency_ms: "agent.sqlite_ledger" },
  printing_report: { report_latency_ms: "agent.gateway_status_report" },
  render_transport_start: { local_execution_ms: "agent.pre_transport_total" },
  transport_complete: { transport_latency_ms: "agent.transport_total" },
  spooler_preflight: { latency_ms: "windows.raw_spooler_preflight" },
  spooler_session: { latency_ms: "windows.raw_spooler_session" },
  pdf_pipeline: { latency_ms: "windows.pdf_total" },
  pdf_worker_wait: { latency_ms: "windows.pdf_worker_wait" },
  pdf_spooler_preflight: { latency_ms: "windows.pdf_spooler_preflight" },
  pdf_renderer_acquire: { latency_ms: "windows.pdf_renderer_acquire" },
  pdf_first_page_render: { latency_ms: "windows.pdf_first_page_render" },
  pdf_start_document: { latency_ms: "windows.pdf_start_document" },
  pdf_end_document: { latency_ms: "windows.pdf_end_document" },
});

export function parseTrace(line) {
  if (!line || !line.trim()) return null;
  if (line.trimStart().startsWith("{")) {
    try {
      const row = JSON.parse(line);
      if (typeof row?.event !== "string" || !row.event.startsWith("print.trace.")) return null;
      return { event: row.event.slice("print.trace.".length), fields: row };
    } catch { return null; }
  }
  const match = /\bprint\.trace\s+([a-z][a-z0-9_]*)\b/i.exec(line);
  if (!match) return null;
  const fields = Object.create(null);
  const tail = line.slice(match.index + match[0].length);
  for (const part of tail.matchAll(/([a-zA-Z_][a-zA-Z_0-9]*)=(-?\d+(?:\.\d+)?|[^\s]+)/g)) {
    fields[part[1]] = part[2];
  }
  return { event: match[1], fields };
}

export function createTraceAggregator() {
  const durations = new Map();
  let events = 0;
  return {
    addLine(line) {
      const parsed = parseTrace(line);
      if (!parsed) return;
      events++;
      const slots = FIELDS[parsed.event];
      if (!slots) return;
      for (const [field, stage] of Object.entries(slots)) {
        const raw = parsed.fields[field];
        if (raw === null || raw === undefined || raw === "") continue;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 86_400_000) continue;
        if (!durations.has(stage)) durations.set(stage, []);
        durations.get(stage).push(value);
      }
    },
    summary() {
      const metrics = {};
      for (const [stage, samples] of [...durations].sort(([a], [b]) => a.localeCompare(b))) {
        samples.sort((a, b) => a - b);
        const quantile = (q) => samples[Math.max(0, Math.ceil(samples.length * q) - 1)];
        metrics[stage] = { count: samples.length, p50_ms: quantile(0.50), p95_ms: quantile(0.95), max_ms: samples.at(-1) };
      }
      return { events, metrics, warning: "Per-process timings overlap; they are not evidence of physical paper output." };
    },
  };
}

export function aggregateTraces(lines) {
  const aggregator = createTraceAggregator();
  for (const line of lines) aggregator.addLine(line);
  return aggregator.summary();
}

export function asTable(summary) {
  const result = [
    "Stage                                Count    p50 ms    p95 ms    max ms",
    "------------------------------------------------------------------------",
  ];
  for (const [name, values] of Object.entries(summary.metrics)) {
    result.push(name.padEnd(36) + String(values.count).padStart(5) +
      String(values.p50_ms).padStart(10) + String(values.p95_ms).padStart(10) +
      String(values.max_ms).padStart(10));
  }
  if (!Object.keys(summary.metrics).length) result.push("(no print.trace timing records found)");
  result.push("Parsed trace events: " + summary.events);
  result.push(summary.warning);
  return result.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const files = args.filter((arg) => arg !== "--json");
  if (files.length === 0) {
    process.stderr.write("Usage: node scripts/print-latency-report.mjs [--json] gateway.log agent.log odoo.log\n");
    process.exitCode = 2;
    return;
  }
  const aggregator = createTraceAggregator();
  for (const file of files) {
    const reader = createReadStream(file, { encoding: "utf8" });
    for await (const line of createInterface({ input: reader, crlfDelay: Infinity })) {
      // Raw log lines are discarded immediately. Retain numeric samples only.
      if (line.length < 128 * 1024) aggregator.addLine(line);
    }
  }
  const summary = aggregator.summary();
  process.stdout.write((json ? JSON.stringify(summary, null, 2) : asTable(summary)) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { process.stderr.write("Analysis failed: " + err.message + "\n"); process.exitCode = 1; });
}
