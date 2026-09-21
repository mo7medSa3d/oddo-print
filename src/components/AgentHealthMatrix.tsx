"use client";

import { useEffect, useState } from "react";

type HealthCheck = { name: string; status: string; message: string; details?: Record<string, unknown> };
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

function rel(t?: string | null) {
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d.getTime())) return "—";
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function statusMeta(s: string) {
  switch (s) {
    case "ONLINE": return { label: "Online", cls: "bg-ink text-white border-ink" };
    case "DEGRADED": return { label: "Degraded", cls: "bg-warn-bg0 text-white border-warn-solid" };
    case "OFFLINE": return { label: "Offline", cls: "bg-surface-3 text-ink-2 border-edge" };
    case "STARTING": return { label: "Starting", cls: "bg-info-solid text-white border-info-solid" };
    default: return { label: s, cls: "bg-surface-3 text-ink-3 border-edge" };
  }
}

function parseCheck(c: HealthCheck, a: AgentHealth) {
  const n = c.name.toLowerCase();
  const st = c.status;
  const d = c.details as any;
  if (n.includes("gateway")) {
    return {
      k: "Gateway",
      v: st === "ok" ? `${rel(new Date(Date.now() - (d?.ageMs || 0)).toISOString())} ago` : rel(a.lastSeenAt) === "—" ? "No signal" : `${rel(a.lastSeenAt)} ago`,
      ok: st === "ok",
    };
  }
  if (n.includes("queue")) {
    const q = d?.queueDepth ?? a.queueDepth;
    return { k: "Queue", v: q === 0 ? "Empty" : `${q}`, ok: q <= 50 };
  }
  if (n.includes("printer")) {
    const total = d?.printerCount ?? a.printerCount;
    const on = d?.onlinePrinterCount ?? a.onlinePrinterCount;
    if (total === 0) return { k: "Printers", v: "0", ok: false };
    return { k: "Printers", v: `${on}/${total}`, ok: on > 0 };
  }
  if (n.includes("version")) {
    return { k: "Version", v: d?.version ? `v${d.version}` : "—", ok: !!d?.version };
  }
  return null;
}

export default function AgentHealthMatrix() {
  const [agents, setAgents] = useState<AgentHealth[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/agents/health", { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(setAgents)
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="h-24 animate-pulse rounded-xl bg-surface-3" />;
  if (!agents || agents.length === 0) return <div className="rounded-xl border border-dashed border-edge bg-surface p-12 text-center text-[13px] font-medium text-ink-3">No agents. Pair one to get started.</div>;

  return (
    <div className="space-y-3">
      {agents.map(a => {
        const meta = statusMeta(a.status);
        const checks = a.checks.map(c => parseCheck(c, a)).filter(Boolean) as { k: string; v: string; ok: boolean }[];
        const uniqueChecks = Array.from(new Map(checks.map(c => [c.k, c])).values()).slice(0, 4);
        return (
          <div key={a.agentId} className="group flex items-center justify-between gap-4 rounded-xl border border-edge bg-surface px-5 py-4 transition hover:border-edge-strong hover:shadow-sm">
            <div className="flex items-center gap-4 min-w-0">
              <div className={`h-2 w-2 rounded-full ${a.status === "ONLINE" ? "bg-ok-solid" : a.status === "OFFLINE" ? "bg-ink-4" : "bg-warn-bg0"}`} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-tight text-ink truncate">{a.name}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${meta.cls}`}>{meta.label}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-3">
                  <span className="font-mono">{a.agentId.slice(0, 8)}</span>
                  <span>•</span>
                  <span>{rel(a.lastSeenAt)}</span>
                  {a.version && <><span>•</span><span>v{a.version}</span></>}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-6">
              <div className="hidden md:flex items-center gap-6">
                {uniqueChecks.map(c => (
                  <div key={c.k} className="text-right">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-4">{c.k}</div>
                    <div className={`text-[13px] font-semibold tabular-nums ${c.ok ? "text-ink" : "text-ink-3"}`}>{c.v}</div>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-1 text-[12px] tabular-nums">
                <span className={`font-semibold ${a.onlinePrinterCount > 0 ? "text-ink" : "text-ink-4"}`}>{a.onlinePrinterCount}/{a.printerCount}</span>
                <span className="text-ink-4">printers</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
