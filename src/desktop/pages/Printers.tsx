import React from "react";
import { Eye, Plus, Printer as PrinterIcon, RefreshCw, Search, Play, Power, Archive, ShieldCheck } from "lucide-react";
import { Button, Card, CardHeader, EmptyState, ErrorState, Input, LoadingState, Mono, Select, StatusBadge, StatusDot } from "../../components/ui";
import { Toolbar, PrinterAvatar } from "../ui";
import type { DesktopState } from "../types";
import { useI18n } from "../../i18n/react";
import { lifecycleLabel } from "../../lib/lifecycle-labels";
import { humanConnection, humanType, isProductionPrinter, labelPrinter, printerEndpoint, printerTone } from "../lib/printers";

export function PrintersPage({ s }: { s: DesktopState }) {
  const { t, locale } = useI18n();
  const rows = s.filteredPrinters.filter(isProductionPrinter);
  const total = s.printers.filter(isProductionPrinter).length;

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
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => s.setShowAdd(true)} icon={<Plus className="h-4 w-4" />} className="h-10 rounded-md">{t("desktop.printers.addPrinter")}</Button>
          <Button variant="secondary" onClick={s.handleDiscover} loading={s.printersLoading} icon={<RefreshCw className="h-4 w-4" />} className="h-10 rounded-md">{t("desktop.printers.discover")}</Button>
          <Button variant="ghost" onClick={s.refreshPrinters} icon={<RefreshCw className="h-4 w-4" />} className="h-10">{t("desktop.printers.refresh")}</Button>
        </div>
      </Toolbar>

      {s.printersError && !s.printersLoading && (total > 0 || !s.gatewayConnected) && <ErrorState title={t("desktop.printers.loadFailed")} message={s.printersError} retry={s.refreshPrinters} />}

      <Card className="overflow-hidden">
        <CardHeader title={<span className="flex items-center gap-2.5">{t("desktop.printers.title")}<span className="rounded-sm bg-surface-2 px-2.5 py-0.5 text-2xs font-semibold tabular-nums text-ink-3 border border-edge">{t("desktop.printers.total", { count: total })}</span></span>} subtitle={t("desktop.printers.subtitle")} icon={<PrinterIcon className="h-4 w-4 text-brand" />} />
        {s.printersLoading ? <div className="p-5"><LoadingState rows={5} /></div> : rows.length === 0 ? (
          <EmptyState icon={<PrinterIcon className="h-8 w-8" />} title={total === 0 ? t("desktop.printers.emptyTitle") : t("desktop.printers.noMatches")} description={total === 0 ? t("desktop.printers.emptyBody") : t("desktop.printers.noMatchesBody")} action={total === 0 ? <><Button variant="primary" onClick={s.handleDiscover} icon={<RefreshCw className="h-4 w-4" />}>{t("desktop.printers.discoverPrinters")}</Button><Button variant="secondary" onClick={() => s.setShowAdd(true)} icon={<Plus className="h-4 w-4" />}>{t("desktop.printers.addPrinter")}</Button></> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-y border-edge bg-surface-2 text-start text-2xs uppercase tracking-wide text-ink-3"><th className="px-5 py-2.5">{t("desktop.printers.colPrinter")}</th><th className="px-4 py-2.5">{t("desktop.printers.colType")}</th><th className="px-4 py-2.5">{t("desktop.printers.colConnection")}</th><th className="hidden px-4 py-2.5 lg:table-cell">{t("desktop.printers.colEndpoint")}</th><th className="px-4 py-2.5">{t("desktop.printers.colConnectivity")}</th><th className="px-4 py-2.5">{t("desktop.printers.colLifecycle")}</th><th className="hidden px-4 py-2.5 xl:table-cell">{t("desktop.printers.colConfig")}</th><th className="px-5 py-2.5 text-end">{t("desktop.printers.colActions")}</th></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.id} className="border-b border-edge last:border-0 hover:bg-surface-2/50 transition-colors">
                  <td className="px-5 py-3"><div className="flex items-center gap-3"><PrinterAvatar name={p.name} size="lg" tone={printerTone(p.status) === "neutral" ? "brand" : printerTone(p.status)} /><div className="min-w-0"><div className="truncate text-sm font-semibold text-ink">{p.name}</div><div className="truncate text-2xs text-ink-4"><Mono>{p.id}</Mono></div></div></div></td>
                  <td className="px-4 py-3 text-ink-2">{humanType(p, locale)}</td>
                  <td className="px-4 py-3 text-ink-2">{humanConnection(p, locale)}</td>
                  <td className="hidden px-4 py-3 text-2xs text-ink-3 lg:table-cell"><Mono>{printerEndpoint(p)}</Mono></td>
                  <td className="px-4 py-3"><div className="space-y-1"><StatusBadge tone={printerTone(p.status)} label={labelPrinter(p.status, locale)} /><div className="text-2xs text-ink-4">{p.agentName || p.agentId || t("desktop.printers.unassigned")} • {p.agentStatus || t("status.unknown").toLowerCase()}</div></div></td>
                  <td className="px-4 py-3"><span className={`inline-flex rounded-sm px-2 py-0.5 text-2xs font-medium border ${p.lifecycle === "retired" ? "bg-surface-2 border-edge text-ink-3" : p.lifecycle === "disabled" ? "bg-warn-bg border-warn-edge text-warn" : "bg-ok-bg border-ok-edge text-ok"}`}>{lifecycleLabel(t, p.lifecycle)}</span></td>
                  <td className="hidden px-4 py-3 text-2xs text-ink-2 xl:table-cell">{p.managementSource === "manager" ? (p.configurationConverged ? t("desktop.printers.applied") : t("desktop.printers.pending")) : t("desktop.printers.agentOwned")}</td>
                  <td className="px-5 py-3"><div className="flex items-center justify-end gap-1.5"><Button size="sm" variant="secondary" onClick={() => s.handleTest(p.id)} icon={<Play className="h-3.5 w-3.5" />}>{t("desktop.printers.test")}</Button>{p.managementSource === "manager" && (p.lifecycle || "active") === "active" && <Button size="sm" variant="ghost" onClick={() => s.updatePrinterLifecycle(p.id, "disabled")} disabled={s.busy} icon={<Power className="h-3.5 w-3.5" />}>{t("desktop.printers.disable")}</Button>}{p.managementSource === "manager" && p.lifecycle === "disabled" && <Button size="sm" variant="ghost" onClick={() => s.updatePrinterLifecycle(p.id, "active")} disabled={s.busy} icon={<Power className="h-3.5 w-3.5" />}>{t("desktop.printers.enable")}</Button>}{p.managementSource === "manager" && p.lifecycle !== "retired" && <Button size="sm" variant="ghost" onClick={() => s.updatePrinterLifecycle(p.id, "retired")} disabled={s.busy} icon={<Archive className="h-3.5 w-3.5" />}>{t("desktop.printers.retire")}</Button>}<Button size="sm" variant="ghost" onClick={() => s.setSelectedPrinter(p)} icon={<Eye className="h-3.5 w-3.5" />}>{t("desktop.printers.details")}</Button></div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {!s.printersLoading && rows.length > 0 && <div className="flex items-center gap-5 border-t border-edge px-5 py-3 text-xs text-ink-3"><span className="inline-flex items-center gap-1.5"><StatusDot tone="ok" /> {t("desktop.printers.onlineCount", { count: s.onlinePrinters })}</span><span className="inline-flex items-center gap-1.5"><StatusDot tone="bad" /> {t("desktop.printers.needAttentionCount", { count: s.offlinePrinters })}</span><span className="ms-auto inline-flex items-center gap-1.5 text-2xs"><ShieldCheck className="h-3.5 w-3.5" /> {t("desktop.printers.encrypted")}</span></div>}
      </Card>
    </div>
  );
}
