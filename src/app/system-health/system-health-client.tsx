"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";

type HealthState = "ok" | "warn" | "error" | "unknown";
type HealthCheck = { name: string; state: HealthState; message: string; latencyMs?: number; details?: Record<string, unknown> };
type SystemHealth = {
  overall: HealthState;
  timestamp: string;
  gateway: HealthCheck;
  database: HealthCheck;
  queue: HealthCheck;
  agents: HealthCheck;
  printers: HealthCheck;
  odoo: HealthCheck;
  billing: HealthCheck;
  version: { gateway: string; schema: number };
  checks: HealthCheck[];
};

function badgeColor(state: HealthState) {
  switch (state) {
    case "ok": return "bg-ok-bg text-ok border-ok-edge";
    case "warn": return "bg-amber-50 text-amber-700 border-amber-200";
    case "error": return "bg-bad-bg text-bad border-bad-edge";
    default: return "bg-zinc-100 text-zinc-600 border-zinc-200";
  }
}

function stateLabel(state: HealthState) {
  return state.toUpperCase();
}

export default function SystemHealthClient() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchHealth() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/system/health", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setHealth(data);
    } catch (e: any) {
      setError(e.message ?? "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchHealth();
  }, []);

  if (loading) return <div className="text-sm text-ink-3">Loading system health…</div>;
  if (error) return (
    <div className="rounded-xl border border-bad-edge bg-bad-bg p-5 text-sm text-bad">
      Failed to load health: {error} <button onClick={fetchHealth} className="ml-3 underline">Retry</button>
    </div>
  );
  if (!health) return null;

  return (
    <div className="space-y-6">
      <div className={`rounded-xl border px-5 py-4 ${badgeColor(health.overall)}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${badgeColor(health.overall)}`}>{stateLabel(health.overall)}</span>
            <span className="text-sm">Overall system health — {health.timestamp}</span>
          </div>
          <button onClick={fetchHealth} className="text-xs underline">Refresh</button>
        </div>
        <div className="mt-2 text-xs">Gateway v{health.version.gateway} • Schema {health.version.schema}</div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {health.checks.map((c) => (
          <div key={c.name} className="rounded-xl border border-edge bg-white p-4 shadow-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">{c.name}</h3>
              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${badgeColor(c.state)}`}>{stateLabel(c.state)}</span>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{c.message}</p>
            {c.latencyMs !== undefined && <div className="mt-1 text-[11px] text-ink-3">{c.latencyMs}ms</div>}
            {c.details && (
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-zinc-50 p-2 text-[11px] text-zinc-600">{JSON.stringify(c.details, null, 2)}</pre>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-edge bg-white p-5">
        <h2 className="text-sm font-semibold">Distributed Tracing</h2>
        <p className="mt-1 text-[13px] text-ink-3">Correlation IDs propagated: request_id / job_id / tenant_id / agent_id / printer_id / attempt_id / claim_id / spooler_job_id. Check X-Request-Id header and structured logs.</p>
        <div className="mt-3 rounded bg-zinc-50 p-3 text-[11px] font-mono text-zinc-700">
          Example log: {`{"ts":"...","level":"info","event":"print.job.success","requestId":"req_...","jobId":"job_...","tenantId":"...","agentId":"...","printerId":"...","attemptId":"attempt_...","claimId":"...","spoolerJobId":"..."}`}
        </div>
      </div>
    </div>
  );
}
