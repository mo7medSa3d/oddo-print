"use client";

import { useEffect, useState } from "react";

type HealthCheck = { name: string; status: string; message: string; lastOk?: string; details?: Record<string, unknown> };
type AgentHealth = {
  agentId: string;
  tenantId: string;
  name: string;
  status: "ONLINE" | "DEGRADED" | "OFFLINE" | "STARTING" | "RECOVERING" | "UNKNOWN";
  lastSeenAt?: string;
  version?: string;
  checks: HealthCheck[];
  queueDepth: number;
  printerCount: number;
  onlinePrinterCount: number;
};

function statusBadge(s: string) {
  switch (s) {
    case "ONLINE": return "bg-ok-bg text-ok border-ok-edge";
    case "DEGRADED": return "bg-amber-50 text-amber-700 border-amber-200";
    case "OFFLINE": return "bg-zinc-100 text-zinc-600 border-zinc-200";
    case "STARTING": return "bg-blue-50 text-blue-700 border-blue-200";
    case "RECOVERING": return "bg-amber-50 text-amber-600 border-amber-200";
    default: return "bg-zinc-100";
  }
}

function checkBadge(s: string) {
  switch (s) {
    case "ok": return "bg-ok-bg text-ok border-ok-edge";
    case "warn": return "bg-amber-50 text-amber-700 border-amber-200";
    case "error": return "bg-bad-bg text-bad border-bad-edge";
    default: return "bg-zinc-100";
  }
}

export default function AgentHealthMatrix() {
  const [agents, setAgents] = useState<AgentHealth[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/agents/health", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setAgents(data);
      } catch (e: any) {
        setError(e.message ?? "Failed");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <div className="text-xs text-ink-3">Loading agent health…</div>;
  if (error) return <div className="text-xs text-bad">{error}</div>;
  if (!agents || agents.length === 0) return <div className="text-xs text-ink-3">No agents.</div>;

  return (
    <div className="space-y-3">
      {agents.map((a) => (
        <div key={a.agentId} className="rounded-xl border border-edge bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{a.name}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusBadge(a.status)}`}>{a.status}</span>
              <span className="font-mono text-[10px] text-zinc-400">{a.agentId.slice(0,12)}</span>
            </div>
            <div className="text-[11px] text-zinc-500">{a.version ? `v${a.version}` : "version unknown"} • {a.queueDepth} queued • {a.onlinePrinterCount}/{a.printerCount} printers</div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {a.checks.map((c) => (
              <div key={c.name} className="rounded-lg border border-edge p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold">{c.name}</span>
                  <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${checkBadge(c.status)}`}>{c.status.toUpperCase()}</span>
                </div>
                <div className="mt-1 text-[11px] text-ink-2">{c.message}</div>
                {c.details && <pre className="mt-1 max-h-20 overflow-auto rounded bg-zinc-50 p-1 text-[10px]">{JSON.stringify(c.details, null, 2)}</pre>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
