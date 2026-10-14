import React from "react";
import { Eye, Plus, Printer as PrinterIcon, RefreshCw, Search, Play, ShieldCheck } from "lucide-react";
import { Button, Card, CardHeader, EmptyState, ErrorState, Input, LoadingState, Select, StatusBadge, StatusDot } from "../../components/ui";
import { Toolbar, PrinterAvatar } from "../ui";
import { PrinterSharingControl } from "../components/PrinterSharingControl";
import type { DesktopState } from "../types";
import { useI18n } from "../../i18n/react";
import { humanConnection, isProductionPrinter, isMainInventoryPrinter, printerDisplayName, printerPresentation, printerHealthCounts } from "../lib/printers";

export function PrintersPage({ s }: { s: DesktopState }) {
  const { t, locale } = useI18n();

  // One shared 15s clock powers both the shell counts and visible printer rows.
  const nowMs = s.nowMs;
  const counts = printerHealthCounts(s.printers.filter(isProductionPrinter), nowMs);

  const rows = s.filteredPrinters.filter(isProductionPrinter);
  const total = s.statusFilter === "saved" ? s.printers.filter(isProductionPrinter).filter((p) => !isMainInventoryPrinter(p)).length : s.totalPrinters;
  const openQueue = (id: string) => { s.setJobPrinterFilter(id); s.setJobTab("all"); s.setJobSearch(""); s.navigate("jobs"); };
  const gatewayIds = new Set(s.printers.map((printer) => printer.id));
  const pendingLocal = [...new Map([...s.discoveredPrinters, ...s.localPrinters].map((p) => [p.id, p])).values()]
    .filter(isProductionPrinter)
    .filter((printer) => !gatewayIds.has(printer.id));

  return (
    <div className="space-y-5">
      <Toolbar>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input value={s.printersFilter} onChange={(e) => s.setPrintersFilter(e.target.value)} placeholder={t("desktop.printers.searchPlaceholder")} className="ps-10 rounded-md" aria-label={t("desktop.printers.searchAria")} />
        </div>
        <Select value={s.statusFilter} onChange={(e) => s.setStatusFilter(e.target.value as typeof s.statusFilter)} className="lg:w-48 rounded-md" aria-label={t("desktop.printers.filterAria")}>
          <option value="all">{t("desktop.printers.allStatuses")}</option>
          <option value="ready">{t("printer.presentation.ready")}</option>
          <option value="printing">{t("printer.presentation.printing")}</option>
          <option value="attention">{t("printer.presentation.attention")}</option>
          <option value="unavailable">{t("printer.presentation.unavailable")}</option>
          <option value="saved">{t("printer.presentation.saved")}</option>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => s.setShowAdd(true)} icon={<Plus className="h-4 w-4" />} className="rounded-md">{t("desktop.printers.addPrinter")}</Button>
          <Button variant="secondary" onClick={s.handleDiscover} loading={s.printersLoading} icon={<RefreshCw className="h-4 w-4" />} className="rounded-md">{t("desktop.printers.discover")}</Button>
          <Button variant="ghost" onClick={s.refreshPrinters} icon={<RefreshCw className="h-4 w-4" />}>{t("desktop.printers.refresh")}</Button>
        </div>
      </Toolbar>

      {s.printersError && !s.printersLoading && <ErrorState title={t("desktop.printers.loadFailed")} message={s.printersError} retry={s.refreshPrinters} />}
      {s.localPrintersError && <ErrorState title={t("desktop.printers.localInventoryFailed")} message={s.localPrintersError} retry={() => void s.refreshLocalPrinters()} />}

      {pendingLocal.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title={t("desktop.printers.localPendingTitle")} subtitle={t("desktop.printers.localPendingBody", { count: pendingLocal.length })} />
          <details>
          <summary className="cursor-pointer px-5 pb-3 text-sm font-semibold text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{t("desktop.printers.details")}</summary>
          <ul className="divide-y divide-edge-subtle lg:hidden">
            {pendingLocal.map((p) => (
              <li key={`local-${p.id}`} className="min-w-0 space-y-2 p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-base font-semibold text-ink">{printerDisplayName(p, locale)}</div>
                  </div>
                  <StatusBadge tone="warn" label={t("desktop.printers.waitingForSync")} />
                </div>
                <div className="break-words text-xs text-ink-3">{humanConnection(p, locale)}</div>
                <PrinterSharingControl s={s} printer={p} candidate />
              </li>
            ))}
          </ul>
          <div className="hidden min-w-0 overflow-x-auto lg:block">
            <table className="data-table w-full text-base">
              <thead><tr className="border-y border-edge bg-surface-2 text-start text-xs font-[550] text-ink-3"><th className="px-5 py-2.5">{t("desktop.printers.colPrinter")}</th><th className="px-4 py-2.5">{t("desktop.printers.colConnection")}</th><th className="px-5 py-2.5">{t("desktop.printers.colConfig")}</th></tr></thead>
              <tbody>{pendingLocal.map((p) => (
                <tr key={`local-${p.id}`} className="border-b border-edge last:border-0">
                  <td className="px-5 py-3"><div className="font-semibold text-ink">{printerDisplayName(p, locale)}</div></td>
                  <td className="px-4 py-3 text-ink-2">{humanConnection(p, locale)}</td>
                  <td className="px-5 py-3"><div className="space-y-2"><StatusBadge tone="warn" label={t("desktop.printers.waitingForSync")} /><PrinterSharingControl s={s} printer={p} candidate /></div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          </details>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader title={<span className="flex flex-wrap items-center gap-2.5">{t("desktop.printers.title")}<span className="min-w-0 max-w-full rounded-sm border border-edge bg-surface-2 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-ink-3 [overflow-wrap:anywhere]">{t("desktop.printers.total", { count: total })}</span></span>} subtitle={t("desktop.printers.subtitle")} icon={<PrinterIcon className="h-4 w-4 text-brand" />} />
        {(s.printersLoading || s.localPrintersLoading) && rows.length === 0 ? <div className="p-5"><LoadingState rows={5} /></div> : rows.length === 0 && s.printersError ? null : rows.length === 0 ? (
          <EmptyState icon={<PrinterIcon className="h-8 w-8" />} title={total === 0 && s.statusFilter === "saved" ? t("printer.presentation.savedEmpty") : total === 0 && pendingLocal.length > 0 ? t("desktop.printers.waitingTitle") : total === 0 ? t("desktop.printers.emptyTitle") : t("desktop.printers.noMatches")} description={total === 0 && s.statusFilter === "saved" ? t("printer.presentation.savedEmptyBody") : total === 0 && pendingLocal.length > 0 ? t("desktop.printers.waitingBody") : total === 0 ? t("desktop.printers.emptyBody") : t("desktop.printers.noMatchesBody")} action={total === 0 && s.statusFilter !== "saved" ? <><Button variant="primary" onClick={s.handleDiscover} icon={<RefreshCw className="h-4 w-4" />}>{t("desktop.printers.discoverPrinters")}</Button><Button variant="secondary" onClick={() => s.setShowAdd(true)} icon={<Plus className="h-4 w-4" />}>{t("desktop.printers.addPrinter")}</Button><Button variant="secondary" onClick={() => s.navigate("test-center")}>{t("desktop.testCenter.title")}</Button></> : undefined} />
        ) : (
          <>
          <ul className="divide-y divide-edge-subtle xl:hidden" aria-label={t("desktop.printers.title")}>
            {rows.map((p) => {
              const view = printerPresentation(p, undefined, nowMs);
              const name = printerDisplayName(p, locale);
              return (
              <li key={p.id} className="min-w-0 px-4 py-4 transition-colors hover:bg-surface-hover sm:px-5">
                <div className="flex min-w-0 items-start gap-3">
                  <PrinterAvatar name={name} size="lg" tone={view.tone} />
                  <div className="min-w-0 flex-1">
                    <button type="button" onClick={() => openQueue(p.id)} aria-label={`${t("desktop.drawer.viewJobs")} — ${name}`} className="block max-w-full text-start text-base font-semibold text-ink [overflow-wrap:anywhere] hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{name}</button>
                    <div className="mt-1 text-xs text-ink-3">{p.agentName || t("printer.unknownAgent")}</div>
                  </div>
                </div>
                <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
                  <StatusBadge tone={view.tone} label={t(view.labelKey)} />
                </div>
                <div className="mt-3 flex min-w-0 flex-wrap gap-2 border-t border-edge-subtle pt-3">
                  <Button size="sm" variant="secondary" disabled={s.busy || !s.gatewayTestPrinterIds.has(p.id)} onClick={() => s.handleTest(p.id)} aria-label={t("desktop.overview.testNamed", { name })} icon={<Play className="h-3.5 w-3.5" />}>{t("desktop.printers.test")}</Button>
                  <Button size="sm" variant="secondary" onClick={() => s.setSelectedPrinter(p)} aria-label={`${t("desktop.printers.details")} — ${name}`} icon={<Eye className="h-3.5 w-3.5" />}>{t("desktop.printers.details")}</Button>
                </div>
                {!s.gatewayTestPrinterIds.has(p.id) && <p className="mt-2 text-xs text-ink-3">{t("desktop.printers.cloudTestUnavailable")}</p>}
                <div className="mt-3"><PrinterSharingControl s={s} printer={p} /></div>
              </li>
              );
            })}
          </ul>
          <div className="hidden min-w-0 overflow-x-auto xl:block">
            <table className="data-table w-full text-base">
              <thead><tr className="border-y border-edge bg-surface-2 text-start text-xs font-[550] text-ink-3"><th className="px-5 py-2.5">{t("desktop.printers.colPrinter")}</th><th className="px-4 py-2.5">{t("common.status")}</th><th className="px-5 py-2.5 text-end">{t("desktop.printers.colActions")}</th></tr></thead>
              <tbody>{rows.map((p) => {
                const view = printerPresentation(p, undefined, nowMs);
                const name = printerDisplayName(p, locale);
                return (
                <tr key={p.id} className="border-b border-edge last:border-0 hover:bg-surface-2/50 transition-colors">
                  <td className="px-5 py-3"><div className="flex items-center gap-3"><PrinterAvatar name={name} size="lg" tone={view.tone} /><div className="min-w-0"><button type="button" onClick={() => openQueue(p.id)} aria-label={`${t("desktop.drawer.viewJobs")} — ${name}`} className="max-w-full break-words text-start text-base font-semibold text-ink hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{name}</button><div className="mt-0.5 text-xs text-ink-3">{p.agentName || t("printer.unknownAgent")}</div></div></div></td>
                  <td className="px-4 py-3"><StatusBadge tone={view.tone} label={t(view.labelKey)} /></td>
                  <td className="px-5 py-3"><div className="flex flex-wrap items-center justify-end gap-1.5">
                     <Button size="sm" variant="secondary" disabled={s.busy || !s.gatewayTestPrinterIds.has(p.id)} onClick={() => s.handleTest(p.id)} aria-label={t("desktop.overview.testNamed", { name })} icon={<Play className="h-3.5 w-3.5" />}>{t("desktop.printers.test")}</Button>
                     <Button size="sm" variant="ghost" onClick={() => s.setSelectedPrinter(p)} aria-label={`${t("desktop.printers.details")} — ${name}`} icon={<Eye className="h-3.5 w-3.5" />}>{t("desktop.printers.details")}</Button>
                   </div><div className="mt-2 max-w-md ms-auto space-y-2">{!s.gatewayTestPrinterIds.has(p.id) && <p className="text-xs text-ink-3">{t("desktop.printers.cloudTestUnavailable")}</p>}<PrinterSharingControl s={s} printer={p} /></div></td>
                </tr>
                );
              })}</tbody>
            </table>
          </div>
          </>
        )}
        {!s.printersLoading && rows.length > 0 && s.statusFilter !== "saved" && <div className="flex flex-wrap items-center gap-4 border-t border-edge px-5 py-3 text-xs text-ink-3">{(["ready", "printing", "attention", "unavailable"] as const).map((state) => <span key={state} className="inline-flex items-center gap-1.5"><StatusDot tone={state === "ready" ? "ok" : state === "printing" ? "info" : state === "attention" ? "bad" : "neutral"} />{t(`printer.presentation.${state}Count`, { count: counts[state] })}</span>)}<span className="ms-auto inline-flex items-center gap-1.5 text-xs"><ShieldCheck className="h-3.5 w-3.5" /> {t("desktop.printers.encrypted")}</span></div>}
      </Card>
    </div>
  );
}
