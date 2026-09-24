import React from "react";
import { Activity, AlertTriangle, CheckCircle2, ClipboardList, Clock, FileText, Play, Printer as PrinterIcon, RefreshCw, Server, Settings, ShieldCheck } from "lucide-react";
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, Mono, StatusBadge } from "../../components/ui";
import { DetailList, StatCard, StatusNotice, ViewAllButton, PrinterAvatar } from "../ui";
import type { DesktopState } from "../types";
import { humanConnection, humanType, isProductionPrinter, jobDocType, jobId, jobPrinterId, jobStatus, labelJob, toneJob, labelPrinter, printerEndpoint, printerTone } from "../lib/printers";

export function OverviewPage({ s }: { s: DesktopState }) {
  const shownPrinters = s.printers.filter(isProductionPrinter);
  const online = shownPrinters.filter((p) => p.status === "online").length;
  const offline = shownPrinters.filter((p) => p.status === "offline" || p.status === "error").length;
  const unknownPrinters = shownPrinters.filter((p) => p.status === "unknown").length;

  const banner = (() => {
    if (!s.gatewayUrl) {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title="Gateway needs configuration" action={<Button variant="primary" onClick={() => s.navigate("settings")} icon={<Settings className="h-4 w-4" />}>Configure Gateway</Button>}>Gateway URL has not been configured yet.</StatusNotice>;
    }
    if (!s.gatewayConnected) {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title="Gateway is unreachable" action={<Button variant="primary" onClick={s.checkHealth} icon={<Activity className="h-4 w-4" />}>Retry check</Button>}>{s.healthError ? `The gateway did not answer — ${s.healthError}` : "The gateway did not answer the last health check."}</StatusNotice>;
    }
    if (!s.isOnline) {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title="Local agent is offline" action={<Button variant="primary" onClick={s.startAgent} icon={<Play className="h-4 w-4" />}>Start agent</Button>}>YasserAgent.exe is not running.</StatusNotice>;
    }
    if (offline > 0 || unknownPrinters > 0 || s.failedJobs > 0) {
      const parts: string[] = [];
      if (offline > 0) parts.push(`${offline} printer${offline > 1 ? "s" : ""} need attention`);
      if (unknownPrinters > 0) parts.push(`${unknownPrinters} unreadable`);
      if (s.failedJobs > 0) parts.push(`${s.failedJobs} job${s.failedJobs > 1 ? "s" : ""} failed`);
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title="Needs attention" action={<Button variant="secondary" onClick={() => s.navigate(offline > 0 ? "printers" : "jobs")}>{offline > 0 ? "Review printers" : "Review jobs"}</Button>}>{parts.join(" • ")}</StatusNotice>;
    }
    return <StatusNotice tone="ok" icon={<CheckCircle2 className="h-5 w-5" />} title="Everything is running normally">Local agent online, gateway reachable, no printers or jobs need attention.</StatusNotice>;
  })();

  return (
    <div className="space-y-6">
      {banner}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Agent" value={s.isOnline ? "Online" : "Offline"} sub={(s.agentStatus as Record<string, unknown> | null)?.note ? String((s.agentStatus as Record<string, unknown>).note) : s.isOnline ? "YasserAgent.exe running" : "Not running"} tone={s.isOnline ? "ok" : "bad"} icon={<Activity className="h-4 w-4" />} />
        <StatCard label="Gateway" value={s.gatewayUrl ? (s.gatewayConnected ? "Connected" : "Unreachable") : "Not configured"} sub={!s.gatewayUrl ? "Set URL in Settings" : s.gatewayConnected ? "Reachable" : "Failed last check"} tone={s.gatewayConnected ? "ok" : s.gatewayUrl ? "bad" : "neutral"} icon={<Server className="h-4 w-4" />} />
        <StatCard label="Printers" value={`${online} / ${shownPrinters.length}`} sub={offline > 0 ? `${offline} need attention` : "Online"} tone={shownPrinters.length > 0 && offline === 0 ? "ok" : shownPrinters.length === 0 ? "neutral" : "warn"} icon={<PrinterIcon className="h-4 w-4" />} />
        <StatCard label="Print jobs" value={String(s.pendingJobs)} sub={s.failedJobs > 0 ? `${s.failedJobs} failed` : "Pending"} tone={s.failedJobs > 0 ? "bad" : s.pendingJobs > 0 ? "info" : "neutral"} icon={<ClipboardList className="h-4 w-4" />} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader title="Printers" subtitle={`${online} of ${shownPrinters.length} online`} icon={<PrinterIcon className="h-4 w-4 text-brand" />} actions={<Button size="sm" variant="secondary" onClick={s.refreshPrinters} icon={<RefreshCw className="h-4 w-4" />}>Refresh</Button>} />
          <div className="px-5 pb-5">
            {s.printersLoading ? <LoadingState rows={3} /> : s.printersError && (shownPrinters.length > 0 || !s.gatewayConnected) ? <ErrorState title="Unable to load printers" message={s.printersError} retry={s.refreshPrinters} /> : shownPrinters.length === 0 ? (
              <EmptyState icon={<PrinterIcon className="h-8 w-8" />} title="No physical printers found" description="Connect a printer, then run Discovery or add manually." action={<><Button variant="primary" onClick={s.handleDiscover} icon={<RefreshCw className="h-4 w-4" />}>Discover</Button><Button variant="secondary" onClick={() => s.setShowAdd(true)} icon={<PrinterIcon className="h-4 w-4" />}>Add printer</Button></>} />
            ) : (
              <div className="space-y-2">
                {shownPrinters.slice(0, 5).map((p) => {
                  const pType = (p.printer_type || "").toLowerCase();
                  const pClass = (p.device_class || "").toLowerCase();
                  const isThermal = pType === "thermal" || pClass === "thermal";
                  const isLabel = pType === "label" || pClass === "label";
                  const isSpooler = p.connection_type === "spooler" || pClass === "laser";
                  const badgeLabel = isLabel ? "ZPL / TSPL" : isThermal ? "ESC/POS" : isSpooler ? "Spooler" : "Raw";
                  return (
                    <div key={p.id} className="flex w-full items-center justify-between gap-4 rounded-[12px] border border-edge bg-surface px-4 py-3 transition-colors hover:border-edge-accent">
                      <button type="button" onClick={() => s.setSelectedPrinter(p)} className="flex min-w-0 flex-1 items-center gap-3 text-left focus:outline-none">
                        <PrinterAvatar name={p.name} size="lg" tone={printerTone(p.status) === "neutral" ? "brand" : printerTone(p.status)} />
                        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-ink">{p.name}</span><span className="block truncate text-[11px] text-ink-3">{humanType(p)} • {humanConnection(p)} • {printerEndpoint(p)}</span></span>
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="hidden sm:inline-flex rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-ink-3">{badgeLabel}</span>
                        <StatusBadge tone={printerTone(p.status)} label={labelPrinter(p.status)} />
                        <Button size="sm" variant="secondary" onClick={() => s.handleTest(p.id)} disabled={s.busy} icon={<Activity className="h-3 w-3 text-brand" />} title={`Test ${p.name}`}>Test</Button>
                      </div>
                    </div>
                  );
                })}
                <ViewAllButton label="View all printers" onClick={() => s.navigate("printers")} />
              </div>
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Activity" subtitle="Agent & gateway health" icon={<Clock className="h-4 w-4 text-brand" />} />
          <div className="px-5 pb-5">
            <DetailList rows={[
              { label: "Last check", value: <Mono>{s.lastStatusCheck ? new Date(s.lastStatusCheck).toLocaleTimeString() : "—"}</Mono> },
              { label: "Gateway", value: <span className="block truncate text-[12px]">{s.gatewayUrl || "—"}</span> },
              { label: "Agent", value: s.isOnline ? "Running" : "Stopped" },
            ]} />
            <div className="mt-4 border-t border-edge pt-4 space-y-2">
              <div className="flex items-center justify-between text-[11px]"><span className="font-semibold uppercase tracking-wide text-ink-3">Gateway Queue</span><span className={`font-semibold ${s.jobsError || s.jobsLoading ? "text-ink-3" : s.pendingJobs > 20 ? "text-warn" : s.pendingJobs > 0 ? "text-brand" : "text-ok"}`}>{s.jobsLoading ? "Checking…" : s.jobsError ? "Unavailable" : s.pendingJobs > 20 ? "Backlogged" : s.pendingJobs > 0 ? "In Flight" : "Clear"}</span></div>
              <div className="flex items-baseline justify-between text-[12px]"><span className="font-bold text-ink tabular-nums">{s.jobsLoading || s.jobsError ? "—" : s.pendingJobs}<span className="font-normal text-ink-3"> waiting</span></span><span className="text-ink-3">last 50</span></div>
            </div>
            <div className="mt-4 border-t border-edge pt-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Quick actions</div>
              <div className="grid grid-cols-2 gap-2"><Button variant="primary" onClick={s.refreshStatus} icon={<RefreshCw className="h-4 w-4" />}>Refresh</Button><Button variant="secondary" onClick={s.checkHealth} icon={<Activity className="h-4 w-4" />}>Check GW</Button></div>
            </div>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader title="Recent jobs" subtitle={`${s.pendingJobs} pending • ${s.failedJobs} failed`} icon={<ClipboardList className="h-4 w-4 text-brand" />} actions={<Button size="sm" variant="ghost" onClick={() => s.navigate("jobs")}>View all</Button>} />
        {s.jobsLoading ? <div className="px-5 pb-5"><LoadingState rows={3} /></div> : s.jobsError ? <div className="px-5 pb-5"><ErrorState title="Jobs unavailable" message={s.jobsError} retry={() => { void s.refreshJobs(); }} /></div> : s.jobs.length === 0 ? <EmptyState icon={<FileText className="h-8 w-8" />} title="No print jobs yet" description="Jobs will appear here as soon as agent starts printing." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="border-y border-edge bg-surface-2 text-left text-[11px] uppercase tracking-wide text-ink-3"><th className="px-5 py-2.5">Document</th><th className="px-4 py-2.5">Printer</th><th className="px-4 py-2.5">Status</th><th className="px-5 py-2.5 text-right">Updated</th></tr></thead>
              <tbody>{s.jobs.slice(0, 5).map((j) => (<tr key={jobId(j)} className="border-b border-edge last:border-0 hover:bg-surface-2/50"><td className="px-5 py-3"><div className="text-[13px] font-semibold text-ink">{jobDocType(j)}</div><div className="font-mono text-[11px] text-ink-3">{jobId(j)}</div></td><td className="px-4 py-3 text-ink-2">{String(s.printers.find((p) => p.id === jobPrinterId(j))?.name || jobPrinterId(j) || "—")}</td><td className="px-4 py-3"><StatusBadge tone={toneJob(jobStatus(j), j.error)} label={labelJob(jobStatus(j), j.error)} /></td><td className="px-5 py-3 text-right text-[11px] text-ink-3">{j.updatedAt ? new Date(String(j.updatedAt)).toLocaleString() : "—"}</td></tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>

      {shownPrinters.length > 0 && (() => {
        const thermal = shownPrinters.find((p) => { const t = (p.printer_type || "").toLowerCase(); const d = (p.device_class || "").toLowerCase(); return t === "thermal" || d === "thermal"; });
        const label = shownPrinters.find((p) => { const t = (p.printer_type || "").toLowerCase(); const d = (p.device_class || "").toLowerCase(); return t === "label" || d === "label"; });
        const spooler = shownPrinters.find((p) => p.connection_type === "spooler" || (p.device_class || "").toLowerCase() === "laser");
        return (
          <Card className="p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-edge bg-brand-subtle text-brand"><Activity className="h-4 w-4" /></span><div className="min-w-0"><div className="text-[13px] font-semibold text-ink">Hardware Profile Testing</div><p className="mt-1 text-[12px] text-ink-3">Verify ESC/POS, ZPL/TSPL, or Spooler rendering.</p></div></div>
              <div className="flex flex-wrap gap-2">{thermal && <Button variant="secondary" onClick={() => s.handleTest(thermal.id)} icon={<Activity className="h-4 w-4" />}>Test ESC/POS</Button>}{label && <Button variant="secondary" onClick={() => s.handleTest(label.id)} icon={<Activity className="h-4 w-4" />}>Test ZPL</Button>}{spooler && <Button variant="secondary" onClick={() => s.handleTest(spooler.id)} icon={<Activity className="h-4 w-4" />}>Test Spooler</Button>}{!thermal && !label && !spooler && <Button variant="secondary" onClick={() => s.handleTest(shownPrinters[0].id)} icon={<Play className="h-4 w-4" />}>Test {shownPrinters[0].name.slice(0, 18)}</Button>}</div>
            </div>
          </Card>
        );
      })()}
    </div>
  );
}
