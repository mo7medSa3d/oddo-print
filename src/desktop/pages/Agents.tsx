import React from "react";
import { Activity, Cpu, HardDrive, Play, RefreshCw, RotateCcw, Server, Settings, ShieldCheck, Square, Lock } from "lucide-react";
import { Button, Card, CardHeader, CopyButton, EmptyState, ErrorState, Mono, StatusBadge, StatusDot } from "../../components/ui";
import { DetailList, StatCard } from "../ui";
import type { DesktopState } from "../types";
import { friendlyPrinterError, isProductionPrinter } from "../lib/printers";

export function AgentsPage({ s }: { s: DesktopState }) {
  const anyStatus = s.agentStatus as Record<string, unknown> | null;
  const physical = s.printers.filter(isProductionPrinter);
  const online = physical.filter((p) => p.status === "online").length;
  const attention = physical.filter((p) => p.status === "offline" || p.status === "error").length;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Local agent" value={s.isOnline ? "Online" : "Offline"} sub={String(anyStatus?.hostname || "This PC")} tone={s.isOnline ? "ok" : "bad"} icon={<Cpu className="h-4 w-4" />} />
        <StatCard label="Printers on this PC" value={`${online} / ${physical.length}`} sub={attention > 0 ? `${attention} need attention` : "Online"} tone={physical.length > 0 && attention === 0 ? "ok" : physical.length === 0 ? "neutral" : "warn"} icon={<HardDrive className="h-4 w-4" />} />
        <StatCard label="Gateway fleet" value={s.gatewayUrl && s.fleetOnline !== null ? `${s.fleetOnline} / ${s.fleetTotal}` : "—"} sub={s.gatewayUrl ? "Agents online" : "Gateway not configured"} tone={s.gatewayUrl && s.fleetOnline !== null && s.fleetOnline > 0 ? "ok" : "neutral"} icon={<Server className="h-4 w-4" />} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="This PC agent" subtitle="Agent this app supervises" icon={<Cpu className="h-4 w-4 text-brand" />} actions={<Button size="sm" variant="secondary" onClick={s.refreshStatus} icon={<RefreshCw className="h-4 w-4" />}>Refresh</Button>} />
          <div className="space-y-4 px-5 pb-5">
            <div className="flex items-center gap-3 rounded-[12px] border border-edge-accent bg-surface-accent p-4">
              <StatusDot tone={s.isOnline ? "ok" : "bad"} pulse={s.isOnline} />
              <div className="min-w-0 flex-1"><div className="text-[14px] font-semibold text-ink">{s.isOnline ? "Agent running" : "Agent stopped"}</div><div className="truncate text-[12px] text-ink-3">{String(anyStatus?.hostname || "This PC")}</div></div>
              <StatusBadge tone={s.isOnline ? "ok" : "bad"} label={s.isOnline ? "Online" : "Offline"} />
            </div>
            <div className="flex flex-wrap gap-2"><Button variant="primary" onClick={s.startAgent} disabled={s.busy} icon={<Play className="h-4 w-4" />} className="h-9 rounded-[10px]">Start</Button><Button variant="secondary" onClick={s.requestStopAgent} disabled={s.busy} icon={<Square className="h-4 w-4" />} className="h-9 rounded-[10px]">Stop</Button><Button variant="ghost" onClick={s.restartAgent} disabled={s.busy} icon={<RotateCcw className="h-4 w-4" />} className="h-9">Restart</Button></div>
            <DetailList rows={[
              { label: "Last check", value: <Mono>{s.lastStatusCheck ? new Date(s.lastStatusCheck).toLocaleString() : "—"}</Mono> },
              { label: "Service", value: String(anyStatus?.service || "Windows service") },
              { label: "Version", value: <Mono>{String(anyStatus?.version || s.version || "—")}</Mono> },
              { label: "Hostname", value: <Mono>{String(anyStatus?.hostname || "—")}</Mono> },
              { label: "Printers", value: `${online}/${physical.length} online • ${attention} attention` },
            ]} />
            {anyStatus?.note ? <p className="rounded-[10px] border border-edge bg-surface-2 px-3 py-2.5 text-[12px] text-ink-2">{String(anyStatus.note)}</p> : null}
            {anyStatus?.error ? <ErrorState title="Agent status unavailable" message={String(anyStatus.error)} retry={s.refreshStatus} /> : null}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Gateway fleet" subtitle={`Agents registered with ${s.gatewayUrl ? "gateway" : "no gateway"}`} icon={<Server className="h-4 w-4 text-brand" />} actions={s.gatewayUrl ? <Button size="sm" variant="secondary" onClick={s.checkHealth} icon={<Activity className="h-4 w-4" />}>Check</Button> : undefined} />
          <div className="px-5 pb-5">
            {!s.gatewayUrl ? <EmptyState icon={<Server className="h-8 w-8" />} title="Gateway not configured" description="Set gateway URL in Settings so agent can register." action={<Button variant="primary" onClick={() => s.navigate("settings")} icon={<Settings className="h-4 w-4" />}>Open settings</Button>} /> : s.healthError ? <ErrorState title="Gateway check failed" message={friendlyPrinterError(s.healthError)} retry={s.checkHealth} /> : s.fleetTotal !== null && s.fleetTotal > 0 ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3"><div className="rounded-[12px] border border-edge bg-surface-2 p-4"><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Total agents</div><div className="mt-1 text-[24px] font-bold tabular-nums text-ink">{s.fleetTotal}</div></div><div className="rounded-[12px] border border-edge bg-surface-2 p-4"><div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Online<StatusDot tone={(s.fleetOnline ?? 0) > 0 ? "ok" : "bad"} /></div><div className="mt-1 flex items-baseline gap-2"><span className="text-[24px] font-bold tabular-nums text-ink">{s.fleetOnline}</span><span className="text-[12px] text-ink-3">of {s.fleetTotal}</span></div></div></div>
                <p className="text-[12px] leading-relaxed text-ink-3">Health probe reports liveness only. Full management available in gateway dashboard.</p>
                <div className="flex items-center gap-2 rounded-[10px] border border-edge bg-surface-2 px-3 py-2"><span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">{s.gatewayUrl}</span><CopyButton value={s.gatewayUrl} label="Copy" onCopied={() => s.setMsg({ text: "Gateway URL copied", type: "success" })} /></div>
              </div>
            ) : <EmptyState icon={<Server className="h-8 w-8" />} title="Fleet report unavailable" description="Gateway reachable but no agents reported." action={<Button variant="secondary" onClick={s.checkHealth} icon={<RefreshCw className="h-4 w-4" />}>Check again</Button>} />}
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader title="How agents work" subtitle="One agent per machine, many printers per agent" icon={<ShieldCheck className="h-4 w-4 text-brand" />} />
        <div className="grid gap-4 px-5 pb-5 md:grid-cols-3">
          {[
            { title: "Pair once", body: "One-time code from gateway dashboard registers this PC. Credentials kept in protected local config.", icon: Lock },
            { title: "Print locally", body: "Agent claims queued jobs and sends bytes directly — RAW, ESC/POS, IPP/IPPS, USB or spooler.", icon: HardDrive },
            { title: "Report honestly", body: "Heartbeats and job status flow back to gateway. Offline queue drains on reconnect.", icon: Activity },
          ].map((c) => {
            const Ic = c.icon;
            return <div key={c.title} className="rounded-[12px] border border-edge p-4"><div className="flex items-center gap-2 text-[13px] font-semibold text-ink"><span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-brand-subtle text-brand border border-edge-accent"><Ic className="h-4 w-4" /></span>{c.title}</div><p className="mt-2 text-[12px] leading-relaxed text-ink-2">{c.body}</p></div>;
          })}
        </div>
      </Card>
    </div>
  );
}
