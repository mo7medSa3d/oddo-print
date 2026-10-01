"use client";

import { useEffect, useState } from "react";
import { Server } from "lucide-react";
import { EmptyState, Skeleton, StatusBadge, type Tone } from "./ui";

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
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function statusMeta(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "ONLINE": return { label: "Online", tone: "ok" };
    case "DEGRADED": return { label: "Degraded", tone: "warn" };
    case "OFFLINE": return { label: "Offline", tone: "neutral" };
    case "STARTING": return { label: "Starting", tone: "info" };
    case "RECOVERING": return { label: "Recovering", tone: "info" };
    default: return { label: "Unknown", tone: "neutral" };
  }
}

function parseCheck(c: HealthCheck, a: AgentHealth) {
  const n = c.name.toLowerCase();
  const st = c.status;
  const d = c.details as { ageMs?: number; queueDepth?: number; printerCount?: number; onlinePrinterCount?: number; version?: string } | undefined;
  if (n.includes("gateway")) {
    return {
      k: "Gateway",
      v: st === "ok" ? `seen ${rel(new Date(Date.now() - (d?.ageMs || 0)).toISOString())}` : rel(a.lastSeenAt) === "—" ? "No signal" : `seen ${rel(a.lastSeenAt)}`,
      ok: st === "ok",
    };
  }
  if (n.includes("queue")) {
    const q = d?.queueDepth ?? a.queueDepth;
    return { k: "Queue", v: q === 0 ? "Empty" : `${q} waiting`, ok: q <= 50 };
  }
  if (n.includes("printer")) {
    const total = d?.printerCount ?? a.printerCount;
    const on = d?.onlinePrinterCount ?? a.onlinePrinterCount;
    if (total === 0) return { k: "Printers", v: "None registered", ok: false };
    return { k: "Printers", v: `${on}/${total} online`, ok: on > 0 };
  }
  if (n.includes("version")) {
    return { k: "Version", v: d?.version ? `v${d.version}` : "—", ok: !!d?.version };
  }
  return null;
}

/**
 * Agent heartbeat matrix (legacy surface kept for compatibility).
 *
 * Each agent reports its own health checks; the row reduces them to the four
 * operator-relevant facts (Gateway, Queue, Printers, Version) and never dumps
 * raw diagnostic payloads.
 */
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

  if (loading) {
    return (
      <div className="space-y-2.5" role="status" aria-label="Loading agent health">
        {[0, 1].map((i) => <Skeleton key={i} className="h-16" />)}
        <span className="sr-only">Loading agent health…</span>
      </div>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <EmptyState
        icon={<Server className="h-5 w-5" aria-hidden />}
        title="No agents paired"
        description="Register an agent to start reporting gateway, queue and printer health."
        size="sm"
      />
    );
  }

  return (
    <div className="space-y-2.5">
      {agents.map(agent => {
        const meta = statusMeta(agent.status);
        const checks = agent.checks.map(c => parseCheck(c, agent)).filter(Boolean) as { k: string; v: string; ok: boolean }[];
        const uniqueChecks = Array.from(new Map(checks.map(c => [c.k, c])).values()).slice(0, 4);
        return (
          <div
            key={agent.agentId}
            className="flex flex-col gap-3 rounded-lg border border-edge bg-surface px-4 py-3.5 transition-colors duration-[140ms] hover:border-edge-strong sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-edge bg-surface-2 text-ink-3"
              >
                <Server className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-base font-[550] tracking-[-0.01em] text-ink">{agent.name}</span>
                  <StatusBadge size="sm" tone={meta.tone} label={meta.label} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-3">
                  <span className="font-mono">{agent.agentId.slice(0, 8)}</span>
                  <span aria-hidden>·</span>
                  <span>{rel(agent.lastSeenAt)}</span>
                  {agent.version && (
                    <>
                      <span aria-hidden>·</span>
                      <span>v{agent.version}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:justify-end">
              {uniqueChecks.map(c => (
                <div key={c.k}>
                  <div className="label-caps">{c.k}</div>
                  <div className={`mt-0.5 text-sm font-[550] tabular-nums ${c.ok ? "text-ink" : "text-ink-3"}`}>{c.v}</div>
                </div>
              ))}
              <div>
                <div className="label-caps">Printer fleet</div>
                <div className="mt-0.5 text-sm font-[550] tabular-nums text-ink">
                  {agent.onlinePrinterCount}/{agent.printerCount}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
