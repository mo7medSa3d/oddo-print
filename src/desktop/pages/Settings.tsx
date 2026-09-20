import React from "react";
import { Activity, ChevronRight, KeyRound, Link2, Play, Power, RotateCcw, Server, ShieldCheck, Square, Copy, Lock } from "lucide-react";
import { Button, Card, CopyButton, ErrorState, Field, Input, StatusBadge, StatusDot } from "../../components/ui";
import { SettingsSection } from "../ui";
import type { DesktopState } from "../types";
import { friendlyPrinterError, labelPrinter } from "../lib/printers";
import { getAutostart, setAutostart } from "../lib/ipc";

export function SettingsPage({ s }: { s: DesktopState }) {
  const anyStatus = s.agentStatus as Record<string, unknown> | null;
  const [autostartBusy, setAutostartBusy] = React.useState(false);
  const paths: [string, string][] = s.runtimePaths ? [["Manager data", s.runtimePaths.manager_data], ["Settings", s.runtimePaths.settings], ["Agent config", s.runtimePaths.agent_config], ["Manager log", s.runtimePaths.manager_log], ["Agent data", s.runtimePaths.agent_data]] : [];

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <SettingsSection title="Gateway connection" description="Where agent reports and receives jobs" icon={<Link2 className="h-4 w-4" />}>
          <div className="flex items-center gap-3 rounded-[12px] border border-edge-accent bg-surface-accent p-4">
            <StatusDot tone={s.gatewayConnected ? "ok" : s.gatewayUrl ? "bad" : "neutral"} pulse={s.gatewayConnected} />
            <div className="min-w-0 flex-1"><div className="text-[13px] font-semibold text-ink">{s.gatewayConnected ? "Connected" : s.gatewayUrl ? "Unreachable" : "Not configured"}</div><div className="truncate text-[11px] text-ink-3">{s.gatewayUrl || "Enter gateway URL below"}</div></div>
            <StatusBadge tone={s.gatewayConnected ? "ok" : s.gatewayUrl ? "bad" : "neutral"} label={s.gatewayConnected ? "Connected" : s.gatewayUrl ? "Unreachable" : "Not configured"} />
          </div>
          <Field label="Gateway URL" htmlFor="gw-url" hint="Base URL of Yasser Gateway, e.g. https://print.example.com">
            <Input id="gw-url" value={s.gatewayUrl} onChange={(e) => s.setGw(e.target.value)} placeholder="https://gateway.example.com" className="h-10 rounded-[10px]" />
          </Field>
          <div className="flex justify-end"><Button variant="primary" onClick={s.checkHealth} loading={s.gatewayChecking} icon={<Activity className="h-4 w-4" />} className="h-10 rounded-[10px]">Check connection</Button></div>
          {s.healthError && <ErrorState title="Gateway check failed" message={friendlyPrinterError(s.healthError)} retry={s.checkHealth} />}
        </SettingsSection>

        <SettingsSection title="Local agent" description="Windows service that talks to printers" icon={<Server className="h-4 w-4" />}>
          <div className="flex items-center gap-3 rounded-[12px] border border-edge-accent bg-surface-accent p-4">
            <StatusDot tone={s.isOnline ? "ok" : "bad"} pulse={s.isOnline} />
            <div className="min-w-0 flex-1"><div className="text-[13px] font-semibold text-ink">{s.isOnline ? "Agent online" : "Agent stopped"}</div><div className="truncate text-[11px] text-ink-3">{String(anyStatus?.hostname || "This PC")}</div></div>
            <StatusBadge tone={s.isOnline ? "ok" : "bad"} label={s.isOnline ? "Running" : "Stopped"} />
          </div>
          <div><div className="mb-2 text-[12px] font-semibold text-ink">Service control</div><div className="flex flex-wrap gap-2"><Button variant="primary" onClick={s.startAgent} disabled={s.busy} icon={<Play className="h-4 w-4" />} className="h-9 rounded-[10px]">Start</Button><Button variant="secondary" onClick={s.requestStopAgent} disabled={s.busy} icon={<Square className="h-4 w-4" />} className="h-9 rounded-[10px]">Stop</Button><Button variant="ghost" onClick={s.restartAgent} disabled={s.busy} icon={<RotateCcw className="h-4 w-4" />} className="h-9">Restart</Button></div></div>
          <div className="border-t border-edge pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-2.5"><Power className="mt-0.5 h-4 w-4 text-ink-3" /><div><div className="text-[13px] font-semibold text-ink">Start with Windows</div><p className="mt-1 text-[11px] text-ink-3">Launch agent automatically at sign-in.</p></div></div>
              <button role="switch" aria-checked={!!s.autostart} aria-busy={s.autostart === null || autostartBusy} disabled={s.autostart === null || autostartBusy} onClick={async () => {
                if (s.autostart === null || autostartBusy) return; const next = !s.autostart; setAutostartBusy(true);
                try { await setAutostart(next); const st = await getAutostart(); s.setAutostartState(st.enabled); s.setMsg({ text: st.enabled ? "Launch at sign-in is on." : "Launch at sign-in is off.", type: "success" }); }
                catch (error) { s.setMsg({ text: friendlyPrinterError(error instanceof Error ? error.message : "Could not update startup preference."), type: "error" }); }
                finally { setAutostartBusy(false); }
              }} className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${s.autostart ? "bg-brand" : "bg-surface-3"}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-xs transition-transform ${s.autostart ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
          </div>
        </SettingsSection>
      </div>

      <Card className="overflow-hidden border-brand/20 billing-premium">
        <div className="flex items-start justify-between gap-4 border-b border-edge bg-surface-2/50 px-5 py-4">
          <div className="flex items-start gap-3"><span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-[10px] border border-edge-accent bg-brand-subtle text-brand"><KeyRound className="h-4 w-4" /></span><div className="min-w-0"><h2 className="text-[14px] font-semibold text-ink">Pair agent</h2><p className="mt-1 text-[11px] text-ink-3">Connect this PC to gateway as managed edge print agent</p></div></div>
          <StatusBadge label={s.isOnline ? (s.gatewayConnected ? "Agent Running" : "Gateway Unreachable") : "Agent Stopped"} tone={s.isOnline ? (s.gatewayConnected ? "ok" : "warn") : "neutral"} />
        </div>
        <div className="grid gap-5 px-5 py-5 lg:grid-cols-[1fr_auto] lg:items-end">
          <ol className="space-y-2.5 text-[12px] text-ink-2">
            {["Enter Gateway URL above and verify connection.", "Generate 6-char pairing code from Central Gateway or Odoo wizard.", "Enter code below — credentials persisted securely via Windows DPAPI."].map((step, i) => (
              <li key={step} className="flex items-center gap-2.5"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-white">{i + 1}</span><span>{step}</span></li>
            ))}
          </ol>
          <div className="flex w-full max-w-sm flex-col gap-3">
            <Field label="6-Character Pairing Code" htmlFor="pair-code" className="flex-1">
              <div className="flex items-center gap-2"><Input id="pair-code" value={s.pairCode} onChange={(e) => s.setPairCode(e.target.value.toUpperCase())} placeholder="AB12CD" maxLength={6} className="text-center font-mono text-[16px] font-bold uppercase tracking-[0.3em] h-11 rounded-[10px]" autoComplete="off" /><Button variant="primary" onClick={s.pair} loading={s.busy} disabled={!s.pairCode.trim() || s.pairCode.trim().length !== 6} icon={<ShieldCheck className="h-4 w-4" />} className="h-11 rounded-[10px]">Pair</Button></div>
            </Field>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-edge bg-surface-2/30 px-5 py-4">
          <div><h2 className="text-[14px] font-semibold text-ink">Current Status</h2><p className="mt-1 text-[11px] text-ink-3">Live snapshot — full agent log at path below.</p></div>
          <Button size="sm" variant="secondary" onClick={() => {
            const report = [`=== Yasser Agent Diagnostic Export ===`, `Generated: ${new Date().toISOString()}`, `Version: ${s.version || "unknown"}`, `Running: ${s.isOnline}`, `Gateway: ${s.gatewayUrl || "Not configured"}`, `Reachable: ${s.gatewayConnected}`, `Printers: ${s.printers.length}`, `Pending: ${s.pendingJobs}, Failed: ${s.failedJobs}`, ``, `=== Printers ===`, ...s.printers.map((p) => ` - ${p.name} [${p.status}]`), ``, `=== Paths ===`, ...paths.map(([k, v]) => ` - ${k}: ${v}`)].join("\n");
            navigator.clipboard.writeText(report).then(() => s.setMsg({ text: "Status copied", type: "success" })).catch(() => s.setMsg({ text: "Unable to copy", type: "error" }));
          }} icon={<Copy className="h-3.5 w-3.5" />} className="h-8 rounded-[8px]">Copy Summary</Button>
        </div>
        <div className="p-5 space-y-3">
          <div className="max-h-64 overflow-y-auto rounded-[12px] border border-edge bg-surface-2 p-3 text-[12px] space-y-2">
            <div className="flex items-center justify-between"><span className="font-medium text-ink-2">Agent service</span><span className={s.isOnline ? "font-semibold text-emerald-600" : "font-semibold text-red-600"}>{s.isOnline ? "Running" : "Stopped"}</span></div>
            <div className="flex items-center justify-between"><span className="font-medium text-ink-2">Gateway</span><span className={s.gatewayConnected ? "font-semibold text-emerald-600" : "font-semibold text-amber-600"}>{s.gatewayConnected ? "Reachable" : s.gatewayUrl ? "Failed check" : "Not configured"}</span></div>
            {s.healthError && <div className="rounded-[8px] border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{friendlyPrinterError(s.healthError)}</div>}
            <div className="flex items-center justify-between"><span className="font-medium text-ink-2">Devices</span><span className="font-semibold text-ink tabular-nums">{s.printers.length}</span></div>
            {s.printers.map((p) => (<div key={p.id} className="flex items-center justify-between rounded-[8px] border border-edge bg-surface px-2.5 py-1.5"><span className="truncate text-ink-2">{p.name}</span><span className={`font-semibold text-[11px] ${p.status === "online" ? "text-emerald-600" : p.status === "offline" || p.status === "error" ? "text-red-600" : "text-amber-600"}`}>{labelPrinter(p.status)}</span></div>))}
            {s.printers.length === 0 && <p className="text-[11px] text-ink-3">No devices reported yet.</p>}
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <button onClick={() => s.setAdvancedOpen(!s.advancedOpen)} className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-surface-2"><span className="text-[14px] font-semibold text-ink">Advanced</span><ChevronRight className={`h-4 w-4 text-ink-3 transition-transform ${s.advancedOpen ? "rotate-90" : ""}`} /></button>
        {s.advancedOpen && (
          <div className="grid gap-5 border-t border-edge px-5 py-5 lg:grid-cols-2">
            <div><div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Security</div><p className="text-[12px] text-ink-2 leading-relaxed">Pairing uses one-time code; credentials stored with OS-level protection, never displayed.</p><div className="mt-3 inline-flex items-center gap-2 rounded-[10px] border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] font-medium text-emerald-700"><Lock className="h-4 w-4" />Credentials stay on this PC</div></div>
            <div><div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Data locations</div>{paths.length > 0 ? <div className="space-y-1.5">{paths.map(([label, path]) => (<div key={label} className="flex items-center gap-2 rounded-[10px] border border-edge bg-surface-2 px-3 py-2"><span className="w-24 text-[11px] font-semibold text-ink-2">{label}</span><span className="flex-1 truncate font-mono text-[11px] text-ink-3">{path}</span><CopyButton value={path} label="Copy" onCopied={() => s.setMsg({ text: "Copied", type: "success" })} /></div>))}</div> : <p className="text-[12px] text-ink-3">Loading paths…</p>}<p className="mt-4 text-[11px] text-ink-3">Yasser Manager • v{s.version || "—"} • © 2026</p></div>
          </div>
        )}
      </Card>
    </div>
  );
}
