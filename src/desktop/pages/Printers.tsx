import React from "react";
import { AlertTriangle, Eye, Plus, Printer as PrinterIcon, RefreshCw, Search, Play, ShieldCheck } from "lucide-react";
import { Button, Card, CardHeader, EmptyState, ErrorState, Input, LoadingState, Mono, Select, StatusBadge, StatusDot } from "../../components/ui";
import { Toolbar, PrinterAvatar } from "../ui";
import type { DesktopState } from "../types";
import { useI18n } from "../../i18n/react";
import { lifecycleLabel } from "../../lib/lifecycle-labels";
import { humanConnection, humanType, isProductionPrinter, labelPrinter, printerAgentView, printerDisplayStatus, printerHealthCounts, printerEndpoint, printerIsStale, printerTone } from "../lib/printers";

export function PrintersPage({ s }: { s: DesktopState }) {
  const { t, locale } = useI18n();

  // One shared 15s clock powers both the shell counts and visible printer rows.
  const nowMs = s.nowMs;
  const { offline, unknown } = printerHealthCounts(s.printers.filter(isProductionPrinter), nowMs);

  const rows = s.filteredPrinters.filter(isProductionPrinter);
  const total = s.printers.filter(isProductionPrinter).length;
  const gatewayIds = new Set(s.printers.map((printer) => printer.id));
  const pendingLocal = s.discoveredPrinters
    .filter(isProductionPrinter)
    .filter((printer) => !gatewayIds.has(printer.id));

  return (
    <div className="space-y-5">
      <Toolbar>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input value={s.printersFilter} onChange={(e) => s.setPrintersFilter(e.target.value)} placeholder={t("desktop.printers.searchPlaceholder")} className="ps-10 h-10 rounded-md" aria-label={t("desktop.printers.searchAria")} />
        </div>
        <Select value={s.statusFilter} onChange={(e) => s.setStatusFilter(e.target.value as typeof s.statusFilter)} className="lg:w-44 h-10 rounded-md" aria-label={t("desktop.printers.filterAria")}>
          <option value="all">{t("desktop.printers.allStatuses")}</option>
          <option value="online">{t("status.online")}</option>
          <option value="busy">{t("status.busy")}</option>
          <option value="offline">{t("status.offline")}</option>
          <option value="error">{t("status.error")}</option>
          <option value="unknown">{t("status.unknown")}</option>
          <option value="stale">{t("status.stale")}</option>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => s.setShowAdd(true)} icon={<Plus className="h-4 w-4" />} className="h-10 rounded-md">{t("desktop.printers.addPrinter")}</Button>
          <Button variant="secondary" onClick={s.handleDiscover} loading={s.printersLoading} icon={<RefreshCw className="h-4 w-4" />} className="h-10 rounded-md">{t("desktop.printers.discover")}</Button>
          <Button variant="ghost" onClick={s.refreshPrinters} icon={<RefreshCw className="h-4 w-4" />} className="h-10">{t("desktop.printers.refresh")}</Button>
        </div>
      </Toolbar>

      {s.printersError && !s.printersLoading && <ErrorState title={t("desktop.printers.loadFailed")} message={s.printersError} retry={s.refreshPrinters} />}

      {s.discoveryWarning && (
        <div className="flex items-start gap-2 rounded-md border border-warn-edge bg-warn-bg px-4 py-3 text-sm text-warn" role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div><div className="font-semibold">{t("desktop.printers.discoveryWarningTitle")}</div><div className="mt-1 break-words text-sm text-ink-2">{s.discoveryWarning}</div></div>
        </div>
      )}

      {s.discoveredVirtualPrinters.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader
            title={t("desktop.printers.virtualTitle")}
            subtitle={t("desktop.printers.virtualBody", { count: s.discoveredVirtualPrinters.length })}
          />
          <ul className="divide-y divide-edge-subtle">
            {s.discoveredVirtualPrinters.map((p) => {
              const linked = [...s.printers, ...(s.pendingVirtualGatewayPrinters ?? [])].find((remote) =>
                (remote.config?.spooler_name === (p.spoolerName ?? p.spooler_name) ||
                 remote.spoolerName === (p.spoolerName ?? p.spooler_name)) && remote.lifecycle !== "retired");
              return (
                <li key={`virtual-${p.id}`} className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="break-words font-semibold text-ink">{p.name}</div>
                    <div className="break-all text-xs text-ink-3" dir="ltr">{p.spoolerName ?? p.spooler_name ?? p.id}</div>
                    <div className="mt-1 text-xs text-ink-3">{t("desktop.printers.virtualNotice")}</div>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                    {linked ? (
                      <>
                        <StatusBadge tone="warn" label={isProductionPrinter(linked) ? t("desktop.printers.virtualLinked") : t("desktop.printers.waitingForSync")} />
                        {isProductionPrinter(linked) && <Button size="sm" variant="secondary" disabled={s.busy} onClick={() => s.handleTest(linked.id)} icon={<Play className="h-4 w-4" />}>{t("desktop.printers.test")}</Button>}
                      </>
                    ) : (
                      <Button size="sm" variant="primary" disabled={s.busy} onClick={() => s.enableVirtualPrinterTest(p)}>
                         {t("desktop.printers.virtualEnable")}
                       </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {pendingLocal.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title={t("desktop.printers.localPendingTitle")} subtitle={t("desktop.printers.localPendingBody", { count: pendingLocal.length })} />
          <>
          <ul className="divide-y divide-edge-subtle lg:hidden">
            {pendingLocal.map((p) => (
              <li key={`local-${p.id}`} className="min-w-0 space-y-2 p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-sm font-semibold text-ink">{p.name}</div>
                    <div className="mt-1 max-w-full break-all font-mono text-xs text-ink-3" dir="ltr">{p.id}</div>
                  </div>
                  <StatusBadge tone="warn" label={t("desktop.printers.waitingForSync")} />
                </div>
                <div className="break-words text-xs text-ink-3">{humanConnection(p, locale)}</div>
              </li>
            ))}
          </ul>
          <div className="hidden min-w-0 overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead><tr className="border-y border-edge bg-surface-2 text-start text-xs font-[550] text-ink-3"><th className="px-5 py-2.5">{t("desktop.printers.colPrinter")}</th><th className="px-4 py-2.5">{t("desktop.printers.colConnection")}</th><th className="hidden px-4 py-2.5 lg:table-cell">{t("desktop.printers.colEndpoint")}</th><th className="px-5 py-2.5">{t("desktop.printers.colConfig")}</th></tr></thead>
              <tbody>{pendingLocal.map((p) => (
                <tr key={`local-${p.id}`} className="border-b border-edge last:border-0">
                  <td className="px-5 py-3"><div className="font-semibold text-ink">{p.name}</div><div className="mt-0.5"><Mono className="text-xs text-ink-4">{p.id}</Mono></div></td>
                  <td className="px-4 py-3 text-ink-2">{humanConnection(p, locale)}</td>
                  <td className="hidden px-4 py-3 text-xs text-ink-3 lg:table-cell"><Mono>{printerEndpoint(p)}</Mono></td>
                  <td className="px-5 py-3"><StatusBadge tone="warn" label={t("desktop.printers.waitingForSync")} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          </>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader title={<span className="flex items-center gap-2.5">{t("desktop.printers.title")}<span className="rounded-sm border border-edge bg-surface-2 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-ink-3">{t("desktop.printers.total", { count: total })}</span></span>} subtitle={t("desktop.printers.subtitle")} icon={<PrinterIcon className="h-4 w-4 text-brand" />} />
        {s.printersLoading ? <div className="p-5"><LoadingState rows={5} /></div> : rows.length === 0 && s.printersError ? null : rows.length === 0 ? (
          <EmptyState icon={<PrinterIcon className="h-8 w-8" />} title={total === 0 && pendingLocal.length > 0 ? t("desktop.printers.waitingTitle") : total === 0 ? t("desktop.printers.emptyTitle") : t("desktop.printers.noMatches")} description={total === 0 && pendingLocal.length > 0 ? t("desktop.printers.waitingBody") : total === 0 ? t("desktop.printers.emptyBody") : t("desktop.printers.noMatchesBody")} action={total === 0 ? <><Button variant="primary" onClick={s.handleDiscover} icon={<RefreshCw className="h-4 w-4" />}>{t("desktop.printers.discoverPrinters")}</Button><Button variant="secondary" onClick={() => s.setShowAdd(true)} icon={<Plus className="h-4 w-4" />}>{t("desktop.printers.addPrinter")}</Button></> : undefined} />
        ) : (
          <>
          <ul className="divide-y divide-edge-subtle xl:hidden" aria-label={t("desktop.printers.title")}>
            {rows.map((p) => (
              <li key={p.id} className="min-w-0 px-4 py-4 transition-colors hover:bg-surface-hover sm:px-5">
                <div className="flex min-w-0 items-start gap-3">
                  <PrinterAvatar name={p.name} size="lg" tone={printerTone(printerDisplayStatus(p, nowMs)) === "neutral" ? "brand" : printerTone(printerDisplayStatus(p, nowMs))} />
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-sm font-semibold text-ink">{p.name}</div>
                    <span className="mt-1 block max-w-full truncate font-mono text-xs text-ink-4" dir="ltr" title={p.id}>{p.id}</span>
                  </div>
                </div>
                <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
                  <StatusBadge tone={printerTone(printerDisplayStatus(p, nowMs))} label={labelPrinter(printerDisplayStatus(p, nowMs), locale)} />
                  {printerIsStale(p, nowMs) && <StatusBadge tone="warn" label={t("status.stale")} />}
                  <StatusBadge tone={p.lifecycle === "retired" ? "neutral" : p.lifecycle === "disabled" ? "warn" : "ok"} label={lifecycleLabel(t, p.lifecycle)} />
                </div>
                <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <div className="min-w-0"><dt className="text-ink-4">{t("desktop.printers.colType")}</dt><dd className="break-words font-medium text-ink-2">{humanType(p, locale)}</dd></div>
                  <div className="min-w-0"><dt className="text-ink-4">{t("desktop.printers.colConnection")}</dt><dd className="break-words font-medium text-ink-2">{humanConnection(p, locale)}</dd></div>
                  <div className="col-span-2 min-w-0"><dt className="text-ink-4">{t("desktop.printers.colConnectivity")}</dt><dd className="break-words font-medium text-ink-2">{p.agentName || p.agentId || t("desktop.printers.unassigned")} · {printerAgentView(p, nowMs, locale).label}</dd></div>
                </dl>
                <div className="mt-3 flex min-w-0 flex-wrap gap-2 border-t border-edge-subtle pt-3">
                  <Button size="sm" variant="secondary" onClick={() => s.handleTest(p.id)} icon={<Play className="h-3.5 w-3.5" />}>{t("desktop.printers.test")}</Button>
                  <Button size="sm" variant="secondary" onClick={() => s.setSelectedPrinter(p)} icon={<Eye className="h-3.5 w-3.5" />}>{t("desktop.printers.details")}</Button>
                  
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden min-w-0 overflow-x-auto xl:block">
            <table className="w-full text-sm">
              <thead><tr className="border-y border-edge bg-surface-2 text-start text-xs font-[550] text-ink-3"><th className="px-5 py-2.5">{t("desktop.printers.colPrinter")}</th><th className="px-4 py-2.5">{t("desktop.printers.colType")}</th><th className="px-4 py-2.5">{t("desktop.printers.colConnection")}</th><th className="hidden px-4 py-2.5 lg:table-cell">{t("desktop.printers.colEndpoint")}</th><th className="px-4 py-2.5">{t("desktop.printers.colConnectivity")}</th><th className="px-4 py-2.5">{t("desktop.printers.colLifecycle")}</th><th className="hidden px-4 py-2.5 xl:table-cell">{t("desktop.printers.colConfig")}</th><th className="px-5 py-2.5 text-end">{t("desktop.printers.colActions")}</th></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.id} className="border-b border-edge last:border-0 hover:bg-surface-2/50 transition-colors">
                  <td className="px-5 py-3"><div className="flex items-center gap-3"><PrinterAvatar name={p.name} size="lg" tone={printerTone(printerDisplayStatus(p, nowMs)) === "neutral" ? "brand" : printerTone(printerDisplayStatus(p, nowMs))} /><div className="min-w-0"><div className="truncate text-sm font-semibold text-ink">{p.name}</div><div className="mt-0.5 truncate"><Mono className="text-xs text-ink-4">{p.id}</Mono></div></div></div></td>
                  <td className="px-4 py-3 text-ink-2">{humanType(p, locale)}</td>
                  <td className="px-4 py-3 text-ink-2">{humanConnection(p, locale)}</td>
                  <td className="hidden px-4 py-3 text-xs text-ink-3 lg:table-cell"><Mono>{printerEndpoint(p)}</Mono></td>
                  <td className="px-4 py-3"><div className="space-y-1"><StatusBadge tone={printerTone(printerDisplayStatus(p, nowMs))} label={labelPrinter(printerDisplayStatus(p, nowMs), locale)} />{printerIsStale(p, nowMs) ? <StatusBadge tone="warn" label={t("status.stale")} /> : null}<div className="text-xs text-ink-4">{p.agentName || p.agentId || t("desktop.printers.unassigned")} • {printerAgentView(p, nowMs, locale).label}</div></div></td>
                  <td className="px-4 py-3"><StatusBadge tone={p.lifecycle === "retired" ? "neutral" : p.lifecycle === "disabled" ? "warn" : "ok"} label={lifecycleLabel(t, p.lifecycle)} /></td>
                  <td className="hidden px-4 py-3 text-xs text-ink-2 xl:table-cell">{p.managementSource === "manager" ? (p.configurationConverged ? t("desktop.printers.applied") : t("desktop.printers.pending")) : t("desktop.printers.agentOwned")}</td>
                  <td className="px-5 py-3"><div className="flex flex-wrap items-center justify-end gap-1.5">
                     <Button size="sm" variant="secondary" onClick={() => s.handleTest(p.id)} icon={<Play className="h-3.5 w-3.5" />}>{t("desktop.printers.test")}</Button>
                     <Button size="sm" variant="ghost" onClick={() => s.setSelectedPrinter(p)} icon={<Eye className="h-3.5 w-3.5" />}>{t("desktop.printers.details")}</Button>
                   </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          </>
        )}
        {!s.printersLoading && rows.length > 0 && <div className="flex items-center gap-5 border-t border-edge px-5 py-3 text-xs text-ink-3"><span className="inline-flex items-center gap-1.5"><StatusDot tone="ok" /> {t("desktop.printers.onlineCount", { count: s.onlinePrinters })}</span><span className="inline-flex items-center gap-1.5"><StatusDot tone="bad" /> {t("desktop.printers.needAttentionCount", { count: offline + unknown })}</span><span className="ms-auto inline-flex items-center gap-1.5 text-xs"><ShieldCheck className="h-3.5 w-3.5" /> {t("desktop.printers.encrypted")}</span></div>}
      </Card>
    </div>
  );
}
