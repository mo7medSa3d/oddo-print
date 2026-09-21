"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleOff,
  Info,
  Loader2,
  Network,
  Printer,
  Server,
  SlidersHorizontal,
} from "lucide-react";

type HealthCheck = {
  name: string;
  status: "ok" | "warn" | "error" | "unknown" | string;
  message: string;
  observed?: boolean;
  lastOk?: string;
  details?: Record<string, unknown>;
};

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

function relativeTime(value?: string): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function humanStatus(status: AgentHealth["status"]) {
  switch (status) {
    case "ONLINE": return { label: "Online", tone: "ok", icon: CheckCircle2, hint: "Agent is connected and sending recent heartbeats." };
    case "DEGRADED": return { label: "Needs attention", tone: "warn", icon: AlertTriangle, hint: "Agent is reachable, but one or more runtime signals need attention." };
    case "OFFLINE": return { label: "Offline", tone: "neutral", icon: CircleOff, hint: "No recent heartbeat. Check the Windows Service YasserPrintAgent and network connectivity." };
    case "STARTING": return { label: "Starting", tone: "info", icon: Loader2, hint: "Agent was recently registered and has not sent its first heartbeat yet." };
    case "RECOVERING": return { label: "Recovering", tone: "warn", icon: Activity, hint: "The agent is transitioning back toward a healthy runtime state." };
    default: return { label: "Unknown", tone: "neutral", icon: Info, hint: "Gateway cannot confirm the current runtime state." };
  }
}

function toneClasses(tone: string) {
  switch (tone) {
    case "ok": return "border-ok-edge bg-ok-bg text-ok";
    case "warn": return "border-warn-edge bg-warn-bg text-warn";
    case "bad": return "border-bad-edge bg-bad-bg text-bad";
    case "info": return "border-brand/20 bg-brand-subtle text-brand";
    default: return "border-edge bg-surface-2 text-ink-3";
  }
}

function checkStatus(status: string) {
  switch (status) {
    case "ok": return { label: "Healthy", tone: "ok" };
    case "warn": return { label: "Needs attention", tone: "warn" };
    case "error": return { label: "Problem", tone: "bad" };
    default: return { label: "Not confirmed", tone: "neutral" };
  }
}

function friendlyCheckName(name: string) {
  if (name.startsWith("Heartbeat")) return "Heartbeat";
  return name;
}

function humanizeDetailKey(key: string) {
  const labels: Record<string, string> = {
    ageMs: "Signal age",
    thresholdMs: "Healthy threshold",
    queueDepth: "Queued jobs",
    printerCount: "Printers",
    onlinePrinterCount: "Printers online",
    version: "Version",
    os: "Operating system",
    hostname: "Computer",
    source: "Source",
    inferredFrom: "Derived from",
    note: "Note",
  };
  return labels[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function formatDetailValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "ageMs" || key === "thresholdMs") {
    const ms = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(ms)) {
      if (ms < 1000) return `${ms}ms`;
      if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
      return `${Math.round(ms / 60_000)}m`;
    }
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function guidanceForCheck(check: HealthCheck): string | null {
  const name = check.name.toLowerCase();
  if (check.status === "error" && name.includes("gateway")) {
    return "Check that the Agent service is running and can reach the Gateway.";
  }
  if (check.status === "warn" && name === "printers") {
    return "At least one registered printer is not currently online.";
  }
  if (check.status === "warn" && name === "queue") {
    return "The queue is growing; inspect active jobs if this persists.";
  }
  if (check.status === "unknown" && name.startsWith("heartbeat")) {
    return "This is a derived signal, not a separate transport measurement.";
  }
  return null;
}

function CheckCard({ check }: { check: HealthCheck }) {
  const [showDetails, setShowDetails] = useState(false);
  const state = checkStatus(check.status);
  const StatusIcon = state.tone === "ok"
    ? CheckCircle2
    : state.tone === "warn"
      ? AlertTriangle
      : state.tone === "bad"
        ? CircleAlert
        : Info;
  const details = Object.entries(check.details ?? {}).filter(([, value]) => value !== undefined && value !== null);

  return (
    <div className="rounded-[12px] border border-edge bg-surface p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px] font-semibold text-ink">{friendlyCheckName(check.name)}</span>
            <span className="rounded-full border border-edge bg-surface-2 px-1.5 py-0.5 text-[9px] font-semibold text-ink-3">
              {check.observed === false ? "Derived" : "Direct"}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{check.message.replace(" (observed)", "").replace(" (inferred)", "")}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-bold ${toneClasses(state.tone)}`}>
          <StatusIcon className="h-3 w-3" />
          {state.label}
        </span>
      </div>

      {check.lastOk && (
        <div className="mt-3 flex items-center gap-1.5 text-[10px] text-ink-3">
          <Activity className="h-3 w-3" />
          Last healthy signal {relativeTime(check.lastOk)}
        </div>
      )}

      {guidanceForCheck(check) && (
        <div className="mt-3 rounded-[9px] border border-edge bg-surface-2 px-2.5 py-2 text-[10px] leading-relaxed text-ink-2">
          {guidanceForCheck(check)}
        </div>
      )}

      {details.length > 0 && (
        <>
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-semibold text-brand hover:underline"
            onClick={() => setShowDetails((value) => !value)}
            aria-expanded={showDetails}
          >
            <SlidersHorizontal className="h-3 w-3" />
            {showDetails ? "Hide technical details" : "Show technical details"}
          </button>
          {showDetails && (
            <div className="mt-2 grid gap-1.5 rounded-[9px] border border-edge bg-surface-2 p-2.5 sm:grid-cols-2">
              {details.map(([key, value]) => (
                <div key={key} className="min-w-0">
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">{humanizeDetailKey(key)}</div>
                  <div className="mt-0.5 break-words text-[10px] text-ink-2">{formatDetailValue(key, value)}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function AgentHealthMatrix() {
  const [agents, setAgents] = useState<AgentHealth[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/agents/health", { cache: "no-store" });
        if (!res.ok) throw new Error(`Unable to load agent status (HTTP ${res.status}).`);
        const data = await res.json();
        if (!cancelled) setAgents(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unable to load agent status.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-[12px] border border-edge bg-surface p-4 text-xs text-ink-3">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading agent status…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-[12px] border border-bad-edge bg-bad-bg p-4 text-xs text-bad">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
      </div>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="rounded-[12px] border border-dashed border-edge bg-surface p-8 text-center">
        <Server className="mx-auto h-5 w-5 text-ink-3" />
        <div className="mt-2 text-[13px] font-semibold text-ink">No agents connected</div>
        <p className="mt-1 text-[11px] text-ink-3">Register an Agent to start receiving runtime status here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {agents.map((agent) => {
        const state = humanStatus(agent.status);
        const StateIcon = state.icon;
        return (
          <section key={agent.agentId} className="rounded-[14px] border border-edge bg-surface p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-surface-2 text-ink-2">
                    <Server className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-[14px] font-semibold text-ink">{agent.name}</div>
                    <div className="font-mono text-[10px] text-ink-3">{agent.agentId.slice(0, 12)}</div>
                  </div>
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-bold ${toneClasses(state.tone)}`}>
                    <StateIcon className={state.tone === "info" ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
                    {state.label}
                  </span>
                </div>
                <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-ink-3">{state.hint}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[420px]">
                <div className="rounded-[9px] bg-surface-2 px-3 py-2">
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">Last seen</div>
                  <div className="mt-1 text-[11px] font-semibold text-ink">{relativeTime(agent.lastSeenAt)}</div>
                </div>
                <div className="rounded-[9px] bg-surface-2 px-3 py-2">
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">Queue</div>
                  <div className="mt-1 text-[11px] font-semibold text-ink">{agent.queueDepth === 0 ? "Empty" : `${agent.queueDepth} waiting`}</div>
                </div>
                <div className="rounded-[9px] bg-surface-2 px-3 py-2">
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">Printers</div>
                  <div className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-ink">
                    <Printer className="h-3 w-3 text-ink-3" /> {agent.onlinePrinterCount}/{agent.printerCount} ready
                  </div>
                </div>
                <div className="rounded-[9px] bg-surface-2 px-3 py-2">
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">Version</div>
                  <div className="mt-1 text-[11px] font-semibold text-ink">{agent.version ? `v${agent.version}` : "Unknown"}</div>
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
              <Network className="h-3.5 w-3.5" />
              Runtime checks
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {agent.checks.map((check) => <CheckCard key={`${agent.agentId}-${check.name}`} check={check} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
