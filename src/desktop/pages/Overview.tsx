import { SetupGuide } from "../components/SetupGuide";
import { Activity, AlertTriangle, CheckCircle2, Info, Loader2, Play, Printer as PrinterIcon, RefreshCw, Server, Settings } from "lucide-react";
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, StatusBadge } from "../../components/ui";
import { StatItem, StatStrip, StatusNotice, ViewAllButton, PrinterAvatar, VirtualBadge } from "../ui";
import { PrinterAvailabilityControl } from "../components/PrinterAvailabilityControl";
import type { DesktopState } from "../types";
import { useI18n } from "../../i18n/react";
import { agentServiceState, agentStatusNoteKey, isProductionPrinter, isMainInventoryPrinter, isVirtualPrinter, printerDisplayName, printerPresentation, printerHealthCounts } from "../lib/printers";

export function OverviewPage({ s }: { s: DesktopState }) {
  const { t, tc, locale } = useI18n();
  const serviceState = agentServiceState(s.agentStatus);
  const shownPrinters = s.printers.filter(isMainInventoryPrinter);
  const registeredLocalIds = new Set(s.localPrinters.map((p) => p.id));
  const pendingLocalPrinters = [...new Map(s.discoveredPrinters.map((p) => [p.id, p])).values()].filter(isProductionPrinter).filter((p) => !registeredLocalIds.has(p.id));
  const { online, offline, unknown: unknownPrinters } = printerHealthCounts(shownPrinters, s.nowMs);
  const banner = (() => {
    if (!s.gatewayUrl) {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={t("desktop.overview.gatewayNeedsConfig")} action={<Button variant="primary" onClick={() => s.navigate("settings")} icon={<Settings className="h-5 w-5" />}>{t("desktop.overview.configureGateway")}</Button>}>{t("desktop.overview.gatewayUrlMissing")}</StatusNotice>;
    }
    if (!s.gatewayConnected) {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={t("desktop.overview.gatewayUnreachable")} action={<Button variant="primary" onClick={s.retrySavedGateway ?? s.checkHealth} loading={s.gatewayChecking} icon={<Activity className="h-5 w-5" />}>{t("desktop.overview.retryCheck")}</Button>}>{s.healthError ? t("desktop.overview.gatewayNoAnswer", { detail: s.healthError }) : t("desktop.overview.gatewayNoAnswerPlain")}</StatusNotice>;
    }
    if (serviceState === "unknown") {
      return <StatusNotice tone="info" icon={<Activity className="h-5 w-5" />} title={t("desktop.agents.statusUnavailable")} action={<Button variant="secondary" onClick={s.refreshStatus} icon={<RefreshCw className="h-5 w-5" />}>{t("desktop.overview.refresh")}</Button>}>{t(agentStatusNoteKey(s.agentStatus))}</StatusNotice>;
    }
    if (serviceState === "stopped") {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={t("desktop.overview.agentOfflineTitle")} action={<Button variant="primary" onClick={s.startAgent} loading={s.busy} icon={<Play className="h-5 w-5" />}>{t("desktop.overview.startAgent")}</Button>}>{t("desktop.overview.agentNotRunning")}</StatusNotice>;
    }
    if (s.localPrintersError) {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={t("desktop.printers.localInventoryFailed")} action={<Button variant="secondary" onClick={() => void s.refreshLocalPrinters()} loading={s.localPrintersLoading} icon={<RefreshCw className="h-5 w-5" />}>{t("desktop.overview.refresh")}</Button>}>{s.localPrintersError}</StatusNotice>;
    }
    if (s.printersError) {
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={t("desktop.overview.needsAttention")} action={<Button variant="secondary" onClick={() => { void s.refreshPrinters(); }} loading={s.printersLoading} icon={<RefreshCw className="h-5 w-5" />}>{t("desktop.overview.refresh")}</Button>}>{s.printersError}</StatusNotice>;
    }
    if (s.printersLoading || s.localPrintersLoading) {
      return <StatusNotice tone="info" icon={<Loader2 className="h-5 w-5 animate-spin" aria-hidden />} title={t("common.checking")} />;
    }
    if (offline > 0 || unknownPrinters > 0) {
      const parts: string[] = [];
      if (offline > 0) parts.push(tc("desktop.overview.printersNeedAttention", offline));
      if (unknownPrinters > 0) parts.push(t("desktop.overview.unreadable", { count: unknownPrinters }));
      return <StatusNotice tone="warn" icon={<AlertTriangle className="h-5 w-5" />} title={t("desktop.overview.needsAttention")} action={<Button variant="secondary" onClick={() => s.navigate("printers")}>{t("desktop.overview.reviewPrinters")}</Button>}>{parts.join(" • ")}</StatusNotice>;
    }
    if (shownPrinters.length === 0) {
      return <StatusNotice tone="info" icon={<PrinterIcon className="h-5 w-5" />} title={pendingLocalPrinters.length > 0 ? t("desktop.printers.waitingTitle") : t("desktop.overview.noPhysicalPrinters")} action={<Button variant="primary" onClick={() => s.navigate("printers")}>{t("desktop.overview.reviewPrinters")}</Button>}>{pendingLocalPrinters.length > 0 ? t("desktop.printers.waitingBody") : t("desktop.overview.noPhysicalPrintersBody")}</StatusNotice>;
    }
    return <StatusNotice tone="ok" icon={<CheckCircle2 className="h-5 w-5" />} title={t("desktop.overview.allNormal")}>{t("desktop.overview.allNormalBody")}</StatusNotice>;
  })();

  return (
    <div className="yw-agent-overview space-y-6">
      <div className="yw-agent-status">{banner}</div>
      <SetupGuide s={s} />

      <div className="yw-agent-stats"><StatStrip columns={3}>
        <StatItem label={t("desktop.overview.statAgent")} value={serviceState === "unknown" ? t("desktop.status.unknown") : s.isOnline ? t("desktop.status.online") : t("desktop.status.offline")} sub={t(agentStatusNoteKey(s.agentStatus))} tone={serviceState === "unknown" ? "neutral" : s.isOnline ? "ok" : "bad"} icon={<Activity className="h-5 w-5" />} />
        <StatItem label={t("desktop.overview.statGateway")} value={s.gatewayUrl ? (s.gatewayConnected ? t("desktop.status.connected") : t("desktop.status.unreachable")) : t("desktop.status.notConfigured")} sub={!s.gatewayUrl ? t("desktop.overview.setUrlInSettings") : s.gatewayConnected ? t("desktop.status.reachable") : t("desktop.status.failedLastCheck")} tone={s.gatewayConnected ? "ok" : s.gatewayUrl ? "bad" : "neutral"} icon={<Server className="h-5 w-5" />} />
        <StatItem label={t("desktop.overview.statPrinters")} value={`${online} / ${shownPrinters.length}`} sub={unknownPrinters > 0 ? t("printer.presentation.unavailableCount", { count: unknownPrinters }) : offline > 0 ? t("printer.presentation.attentionCount", { count: offline }) : t("printer.presentation.availableCount", { count: online })} tone={shownPrinters.length > 0 && offline + unknownPrinters === 0 ? "ok" : shownPrinters.length === 0 ? "neutral" : "warn"} icon={<PrinterIcon className="h-5 w-5" />} />
      </StatStrip></div>

      <div className="grid gap-6">
        <Card className="overflow-hidden rounded-2xl">
          <CardHeader title={t("desktop.overview.printersTitle")} subtitle={t("desktop.overview.printersOnlineCount", { online, total: shownPrinters.length })} icon={<PrinterIcon className="h-4 w-4 text-brand" />} actions={<Button size="sm" variant="secondary" onClick={s.refreshPrinters} loading={s.printersLoading || s.localPrintersLoading} icon={<RefreshCw className="h-5 w-5" />}>{t("desktop.overview.refresh")}</Button>} />
          <div className="px-5 pb-5">
            {(s.printersLoading || s.localPrintersLoading) && shownPrinters.length === 0 ? <LoadingState rows={3} /> : s.printersError && shownPrinters.length === 0 && pendingLocalPrinters.length === 0 ? <ErrorState title={t("desktop.overview.unableToLoadPrinters")} message={s.printersError} retry={s.refreshPrinters} /> : shownPrinters.length === 0 ? (
              <EmptyState
                icon={<PrinterIcon className="h-8 w-8" />}
                title={pendingLocalPrinters.length > 0 ? t("desktop.printers.waitingTitle") : t("desktop.overview.noPhysicalPrinters")}
                description={pendingLocalPrinters.length > 0 ? t("desktop.printers.waitingBody") : t("desktop.overview.noPhysicalPrintersBody")}
                action={<><Button variant="primary" onClick={s.handleDiscover} loading={s.printersLoading} icon={<RefreshCw className="h-5 w-5" />}>{t("desktop.overview.discover")}</Button><Button variant="secondary" onClick={() => s.setShowAdd(true)} icon={<PrinterIcon className="h-5 w-5" />}>{t("desktop.overview.addPrinter")}</Button></>}
              />
            ) : (
              <div className="divide-y divide-edge-subtle">
                {shownPrinters.slice(0, 5).map((p) => {
                  const view = printerPresentation(p, undefined, s.nowMs);
                  const name = printerDisplayName(p, locale);
                  const virtual = isVirtualPrinter(p);
                  return (
                    <div key={p.id} className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl px-2 py-3.5 transition-colors hover:bg-surface-hover/70">
                      <div className="flex w-full min-w-0 items-center gap-3 text-start sm:w-auto sm:flex-1">
                        <PrinterAvatar name={name} size="lg" tone={view.tone} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <button type="button" onClick={() => s.setSelectedPrinter(p)} className="block max-w-full break-words text-start text-base font-semibold text-ink hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{name}</button>
                            {virtual && <VirtualBadge locale={locale} />}
                          </span>
                          {p.agentName && <span className="mt-0.5 block break-words text-xs text-ink-3">{p.agentName}</span>}
                        </span>
                      </div>
                      <div className="flex max-w-full flex-wrap items-center gap-2">
                        <StatusBadge tone={view.tone} label={t(view.labelKey)} />
                        <Button size="sm" variant="ghost" onClick={() => s.setSelectedPrinter(p)}>{t("desktop.printers.details")}</Button>
                      </div>
                      <div className="w-full min-w-0 space-y-2"><PrinterAvailabilityControl s={s} printer={p} /></div>
                    </div>
                  );
                })}
                <ViewAllButton label={t("desktop.overview.viewAllPrinters")} onClick={() => s.navigate("printers")} />
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden rounded-2xl">
        <CardHeader title={t("desktop.jobs.odooTitle")} icon={<Info className="h-4 w-4 text-brand" />} />
        <div className="px-5 pb-5 text-sm leading-6 text-ink-2">{t("desktop.jobs.odooBody")}</div>
      </Card>

    </div>
  );
}
