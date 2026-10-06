import React from "react";
import { Activity, AlertTriangle, CheckCircle2, ClipboardList, Clock, FileText, Play, Printer as PrinterIcon, RefreshCw, Server, Settings, ShieldCheck } from "lucide-react";
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, Mono, StatusBadge } from "../../components/ui";
import { DetailList, StatItem, StatStrip, StatusNotice, ViewAllButton, PrinterAvatar } from "../ui";
import type { DesktopState } from "../types";
import { useI18n } from "../../i18n/react";
import { getPrinterLanguageBadges } from "../../lib/printer-capability";
import { agentStatusNoteKey, humanConnection, humanType, isProductionPrinter, jobDocType, jobId, jobPrinterId, jobStatus, jobTimestamp, labelJob, toneJob, labelPrinter, printerDisplayStatus, printerEndpoint, printerIsStale, printerTone } from "../lib/printers";

export function OverviewPage({ s }: { s: DesktopState }) {
  const { t, tc, locale, formatTime, formatDateTime } = useI18n();
  const shownPrinters = s.printers.filter(isProductionPrinter);
  const gatewayPrinterIds = new Set(shownPrinters.map((p) => p.id));
  const pendingLocalPrinters = s.discoveredPrinters.filter(isProductionPrinter).filter((p) => !gatewayPrinterIds.has(p.id));
  const online = shownPrinters.filter((p) => p.status === "online").length;
  const offline = shownPrinters.filter((p) => p.status === "offline" || p.status === "error").length;
  const unknownPrinters = shownPrinters.filter((p) => p.status === "unknown").length;

  const banner = (() => {
    if (!s.gatewayUrl) {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={t("desktop.overview.gatewayNeedsConfig")} action={<Button variant="primary" onClick={() => s.navigate("settings")} icon={<Settings className="h-4 w-4" />}>{t("desktop.overview.configureGateway")}</Button>}>{t("desktop.overview.gatewayUrlMissing")}</StatusNotice>;
    }
    if (!s.gatewayConnected) {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={t("desktop.overview.gatewayUnreachable")} action={<Button variant="primary" onClick={s.checkHealth} icon={<Activity className="h-4 w-4" />}>{t("desktop.overview.retryCheck")}</Button>}>{s.healthError ? t("desktop.overview.gatewayNoAnswer", { detail: s.healthError }) : t("desktop.overview.gatewayNoAnswerPlain")}</StatusNotice>;
    }
    if (!s.isOnline) {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={t("desktop.overview.agentOfflineTitle")} action={<Button variant="primary" onClick={s.startAgent} icon={<Play className="h-4 w-4" />}>{t("desktop.overview.startAgent")}</Button>}>{t("desktop.overview.agentNotRunning")}</StatusNotice>;
    }
    if (offline > 0 || unknownPrinters > 0 || s.failedJobs > 0) {
      const parts: string[] = [];
      if (offline > 0) parts.push(tc("desktop.overview.printersNeedAttention", offline));
      if (unknownPrinters > 0) parts.push(t("desktop.overview.unreadable", { count: unknownPrinters }));
      if (s.failedJobs > 0) parts.push(tc("desktop.overview.jobsFailed", s.failedJobs));
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={t("desktop.overview.needsAttention")} action={<Button variant="secondary" onClick={() => s.navigate(offline > 0 ? "printers" : "jobs")}>{offline > 0 ? t("desktop.overview.reviewPrinters") : t("desktop.overview.reviewJobs")}</Button>}>{parts.join(" • ")}</StatusNotice>;
    }
    return <StatusNotice tone="ok" icon={<CheckCircle2 className="h-5 w-5" />} title={t("desktop.overview.allNormal")}>{t("desktop.overview.allNormalBody")}</StatusNotice>;
  })();

  return (
    <div className="space-y-6">
      {banner}

      <StatStrip>
        <StatItem label={t("desktop.overview.statAgent")} value={s.isOnline ? t("desktop.status.online") : t("desktop.status.offline")} sub={s.agentStatus ? t(agentStatusNoteKey(s.agentStatus as Record<string, unknown>)) : s.isOnline ? t("desktop.overview.agentRunningExe") : t("desktop.overview.notRunning")} tone={s.isOnline ? "ok" : "bad"} icon={<Activity className="h-4 w-4" />} />
        <StatItem label={t("desktop.overview.statGateway")} value={s.gatewayUrl ? (s.gatewayConnected ? t("desktop.status.connected") : t("desktop.status.unreachable")) : t("desktop.status.notConfigured")} sub={!s.gatewayUrl ? t("desktop.overview.setUrlInSettings") : s.gatewayConnected ? t("desktop.status.reachable") : t("desktop.status.failedLastCheck")} tone={s.gatewayConnected ? "ok" : s.gatewayUrl ? "bad" : "neutral"} icon={<Server className="h-4 w-4" />} />
        <StatItem label={t("desktop.overview.statPrinters")} value={`${online} / ${shownPrinters.length}`} sub={offline > 0 ? t("desktop.overview.unreadable", { count: offline }) : t("desktop.status.online")} tone={shownPrinters.length > 0 && offline === 0 ? "ok" : shownPrinters.length === 0 ? "neutral" : "warn"} icon={<PrinterIcon className="h-4 w-4" />} />
        <StatItem label={t("desktop.overview.statJobs")} value={String(s.pendingJobs)} sub={s.failedJobs > 0 ? tc("desktop.overview.jobsFailed", s.failedJobs) : t("desktop.status.pending")} tone={s.failedJobs > 0 ? "bad" : s.pendingJobs > 0 ? "info" : "neutral"} icon={<ClipboardList className="h-4 w-4" />} />
      </StatStrip>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader title={t("desktop.overview.printersTitle")} subtitle={t("desktop.overview.printersOnlineCount", { online, total: shownPrinters.length })} icon={<PrinterIcon className="h-4 w-4 text-brand" />} actions={<Button size="sm" variant="secondary" onClick={s.refreshPrinters} icon={<RefreshCw className="h-4 w-4" />}>{t("desktop.overview.refresh")}</Button>} />
          <div className="px-5 pb-5">
            {s.printersLoading ? <LoadingState rows={3} /> : s.printersError && pendingLocalPrinters.length === 0 ? <ErrorState title={t("desktop.overview.unableToLoadPrinters")} message={s.printersError} retry={s.refreshPrinters} /> : shownPrinters.length === 0 ? (
              <EmptyState
                icon={<PrinterIcon className="h-8 w-8" />}
                title={pendingLocalPrinters.length > 0 ? t("desktop.printers.waitingTitle") : t("desktop.overview.noPhysicalPrinters")}
                description={pendingLocalPrinters.length > 0 ? t("desktop.printers.waitingBody") : t("desktop.overview.noPhysicalPrintersBody")}
                action={<><Button variant="primary" onClick={s.handleDiscover} icon={<RefreshCw className="h-4 w-4" />}>{t("desktop.overview.discover")}</Button><Button variant="secondary" onClick={() => s.setShowAdd(true)} icon={<PrinterIcon className="h-4 w-4" />}>{t("desktop.overview.addPrinter")}</Button></>}
              />
            ) : (
              <div className="space-y-2">
                {shownPrinters.slice(0, 5).map((p) => {
                  // Language badges derive ONLY from the declared protocol
                  // and connection type (printer-capability.ts) — device
                  // class must never invent a language.
                  const badgeLabel = getPrinterLanguageBadges(p.protocol ?? "unknown", (p.connection_type || p.connectionType) ?? "unknown").join(" · ") || t("desktop.status.unknown");
                  return (
                    <div key={p.id} className="flex w-full items-center justify-between gap-4 rounded-sg border border-edge bg-surface px-4 py-3 transition-colors hover:border-edge-accent">
                      <button type="button" onClick={() => s.setSelectedPrinter(p)} className="flex min-w-0 flex-1 items-center gap-3 text-start focus:outline-none">
                        <PrinterAvatar name={p.name} size="lg" tone={printerTone(printerDisplayStatus(p)) === "neutral" ? "brand" : printerTone(printerDisplayStatus(p))} />
                        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-ink">{p.name}</span><span className="block truncate text-2xs text-ink-3">{humanType(p, locale)} • {humanConnection(p, locale)} • {printerEndpoint(p)}</span></span>
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="hidden sm:inline-flex rounded-sm border border-edge bg-surface-2 px-2 py-0.5 text-2xs font-semibold text-ink-3">{badgeLabel}</span>
                        <div className="flex items-center gap-1"><StatusBadge tone={printerTone(printerDisplayStatus(p))} label={labelPrinter(printerDisplayStatus(p), locale)} />{printerIsStale(p) ? <StatusBadge tone="warn" label={t("status.stale")} /> : null}</div>
                        <Button size="sm" variant="secondary" onClick={() => s.handleTest(p.id)} disabled={s.busy} icon={<Activity className="h-3 w-3 text-brand" />} title={t("desktop.overview.testNamed", { name: p.name })}>{t("desktop.overview.test")}</Button>
                      </div>
                    </div>
                  );
                })}
                <ViewAllButton label={t("desktop.overview.viewAllPrinters")} onClick={() => s.navigate("printers")} />
              </div>
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title={t("desktop.overview.activity")} subtitle={t("desktop.overview.activitySubtitle")} icon={<Clock className="h-4 w-4 text-brand" />} />
          <div className="px-5 pb-5">
            <DetailList rows={[
              { label: t("desktop.overview.lastCheck"), value: <Mono>{s.lastStatusCheck ? formatTime(s.lastStatusCheck) : "—"}</Mono> },
              { label: t("desktop.overview.statGateway"), value: <span className="block truncate text-xs">{s.gatewayUrl || "—"}</span> },
              { label: t("desktop.overview.statAgent"), value: s.isOnline ? t("desktop.status.running") : t("desktop.status.stopped") },
            ]} />
            <div className="mt-4 border-t border-edge pt-4 space-y-2">
              <div className="flex items-center justify-between text-2xs"><span className="font-[550] text-xs text-ink-3">{t("desktop.overview.queueTitle")}</span><span className={`font-semibold ${s.jobsError || s.jobsLoading ? "text-ink-3" : s.pendingJobs > 20 ? "text-warn" : s.pendingJobs > 0 ? "text-brand" : "text-ok"}`}>{s.jobsLoading ? t("desktop.overview.queueChecking") : s.jobsError ? t("desktop.overview.queueUnavailable") : s.pendingJobs > 20 ? t("desktop.overview.queueBacklogged") : s.pendingJobs > 0 ? t("desktop.overview.queueInFlight") : t("desktop.overview.queueClear")}</span></div>
              <div className="flex items-baseline justify-between text-xs"><span className="font-bold text-ink tabular-nums">{s.jobsLoading || s.jobsError ? "—" : s.pendingJobs}<span className="font-normal text-ink-3"> {t("desktop.overview.waiting")}</span></span><span className="text-ink-3">{t("desktop.overview.lastFifty")}</span></div>
            </div>
            <div className="mt-4 border-t border-edge pt-4">
              <div className="mb-2 text-xs font-[550] text-ink-3">{t("desktop.overview.quickActions")}</div>
              <div className="grid grid-cols-2 gap-2"><Button variant="primary" onClick={s.refreshStatus} icon={<RefreshCw className="h-4 w-4" />}>{t("desktop.overview.refresh")}</Button><Button variant="secondary" onClick={s.checkHealth} icon={<Activity className="h-4 w-4" />}>{t("desktop.overview.checkGateway")}</Button></div>
            </div>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader title={t("desktop.overview.recentJobs")} subtitle={t("desktop.overview.recentJobsSubtitle", { pending: s.pendingJobs, failed: s.failedJobs })} icon={<ClipboardList className="h-4 w-4 text-brand" />} actions={<Button size="sm" variant="ghost" onClick={() => s.navigate("jobs")}>{t("desktop.overview.viewAll")}</Button>} />
        {s.jobsLoading ? <div className="px-5 pb-5"><LoadingState rows={3} /></div> : s.jobsError ? <div className="px-5 pb-5"><ErrorState title={t("desktop.overview.jobsUnavailable")} message={s.jobsError} retry={() => { void s.refreshJobs(); }} /></div> : s.jobs.length === 0 ? <EmptyState icon={<FileText className="h-8 w-8" />} title={t("desktop.overview.noJobsYet")} description={t("desktop.overview.noJobsYetBody")} /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-y border-edge bg-surface-2 text-start text-xs font-[550] text-ink-3"><th className="px-5 py-2.5">{t("desktop.overview.colDocument")}</th><th className="px-4 py-2.5">{t("desktop.overview.colPrinter")}</th><th className="px-4 py-2.5">{t("desktop.overview.colStatus")}</th><th className="px-5 py-2.5 text-end">{t("desktop.overview.colUpdated")}</th></tr></thead>
              <tbody>{s.jobs.slice(0, 5).map((j) => (<tr key={jobId(j)} className="border-b border-edge last:border-0 hover:bg-surface-2/50"><td className="px-5 py-3"><div className="text-sm font-semibold text-ink">{jobDocType(j, locale)}</div><div className="font-mono text-2xs text-ink-3">{jobId(j)}</div></td><td className="px-4 py-3 text-ink-2">{String(s.printers.find((p) => p.id === jobPrinterId(j))?.name || jobPrinterId(j) || "—")}</td><td className="px-4 py-3"><StatusBadge tone={toneJob(jobStatus(j), j.error)} label={labelJob(jobStatus(j), j.error, locale)} /></td><td className="px-5 py-3 text-end text-2xs text-ink-3">{formatDateTime(jobTimestamp(j, "updatedAt"))}</td></tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>

      {shownPrinters.length > 0 && (() => {
        // Both wire casings are accepted (Tauri serializes camelCase; the Gateway
        // /api/printers rows are camelCase too), so the hardware-profile cards
        // can actually resolve a thermal / label / spooler device.
        const thermal = shownPrinters.find((p) => { const t = ((p.printer_type || p.printerType) || "").toLowerCase(); const d = (p.device_class || p.deviceClass || "").toLowerCase(); return t === "thermal" || d === "thermal"; });
        const label = shownPrinters.find((p) => { const t = ((p.printer_type || p.printerType) || "").toLowerCase(); const d = (p.device_class || p.deviceClass || "").toLowerCase(); return t === "label" || d === "label"; });
        const spooler = shownPrinters.find((p) => (p.connection_type || p.connectionType) === "spooler" || (p.device_class || p.deviceClass || "").toLowerCase() === "laser");
        return (
          <Card className="p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-md border border-edge bg-brand-subtle text-brand"><Activity className="h-4 w-4" /></span><div className="min-w-0"><div className="text-sm font-semibold text-ink">{t("desktop.overview.hardwareProfile")}</div><p className="mt-1 text-xs text-ink-3">{t("desktop.overview.hardwareProfileBody")}</p></div></div>
              <div className="flex flex-wrap gap-2">{thermal && <Button variant="secondary" onClick={() => s.handleTest(thermal.id)} icon={<Activity className="h-4 w-4" />}>{t("desktop.overview.testEscPos")}</Button>}{label && <Button variant="secondary" onClick={() => s.handleTest(label.id)} icon={<Activity className="h-4 w-4" />}>{t("desktop.overview.testZpl")}</Button>}{spooler && <Button variant="secondary" onClick={() => s.handleTest(spooler.id)} icon={<Activity className="h-4 w-4" />}>{t("desktop.overview.testSpooler")}</Button>}{!thermal && !label && !spooler && <Button variant="secondary" onClick={() => s.handleTest(shownPrinters[0].id)} icon={<Play className="h-4 w-4" />}>{t("desktop.overview.testNamed", { name: shownPrinters[0].name.slice(0, 18) })}</Button>}</div>
            </div>
          </Card>
        );
      })()}
    </div>
  );
}
