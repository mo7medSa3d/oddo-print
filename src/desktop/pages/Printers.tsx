import { Eye, Plus, Printer as PrinterIcon, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Button, Card, CardHeader, EmptyState, ErrorState, Input, LoadingState, Select, StatusBadge, StatusDot } from "../../components/ui";
import { Toolbar, PrinterAvatar, VirtualBadge } from "../ui";
import { PrinterAvailabilityControl } from "../components/PrinterAvailabilityControl";
import type { DesktopState } from "../types";
import { useI18n } from "../../i18n/react";
import { humanConnection, isProductionPrinter, isMainInventoryPrinter, isVirtualPrinter, printerDisplayName, printerPresentation, printerHealthCounts, printerStatusDetail, printerStatusDetailCode } from "../lib/printers";
import type { PrinterInfo } from "../lib/ipc";
import type { Locale } from "../../i18n/config";

/**
 * WP4c: the mapped badge collapses offline+error into "attention" and
 * unknown/stale/not-shared into "unavailable", so the row also shows the
 * raw Agent status_detail code (verbatim, LTR) — offline vs error vs
 * unknown become distinguishable to the user and to support. Renders
 * nothing when the Agent sent no code; absence is never faked.
 */
function StatusDetailLine({ p, locale }: { p: PrinterInfo; locale: Locale }) {
  const code = printerStatusDetailCode(p);
  if (!code) return null;
  const text = printerStatusDetail(p, locale);
  return <div className="mt-1 text-xs text-ink-3">
    {text && text !== code ? <>{text} </> : null}
    <span dir="ltr">{text && text !== code ? `(${code})` : code}</span>
  </div>;
}

export function PrintersPage({ s }: { s: DesktopState }) {
  const { t, locale } = useI18n();

  // One shared 15s clock powers both the shell counts and visible printer rows.
  const nowMs = s.nowMs;
  const productionPrinters = s.printers.filter(isProductionPrinter);
  const counts = printerHealthCounts(productionPrinters, nowMs);
  // Footer badge renders "Shared with Odoo: X / Y" (EN) via i18n catalog.
  const sharedCount = productionPrinters.filter((p) => p.availableToOdoo !== false && p.sharedWithGateway !== false).length;

  const rows = s.filteredPrinters.filter(isProductionPrinter);
  const total = s.statusFilter === "saved" ? s.printers.filter(isProductionPrinter).filter((p) => !isMainInventoryPrinter(p)).length : s.totalPrinters;

  const registeredLocalIds = new Set(s.localPrinters.map((printer) => printer.id));
  const pendingLocal = [...new Map(s.discoveredPrinters.map((p) => [p.id, p])).values()]
    .filter(isProductionPrinter)
    .filter((printer) => !registeredLocalIds.has(printer.id));

  return (
    <div className="space-y-5">
      <Toolbar>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input value={s.printersFilter} onChange={(e) => s.setPrintersFilter(e.target.value)} placeholder={t("desktop.printers.searchPlaceholder")} className="ps-10 rounded-xl" aria-label={t("desktop.printers.searchAria")} />
        </div>
        <Select value={s.statusFilter} onChange={(e) => s.setStatusFilter(e.target.value as typeof s.statusFilter)} className="lg:w-48 rounded-xl" aria-label={t("desktop.printers.filterAria")}>
          <option value="all">{t("desktop.printers.allStatuses")}</option>
          <option value="ready">{t("printer.presentation.ready")}</option>
          <option value="printing">{t("printer.presentation.printing")}</option>
          <option value="attention">{t("printer.presentation.attention")}</option>
          <option value="unavailable">{t("printer.presentation.unavailable")}</option>
          <option value="saved">{t("printer.presentation.saved")}</option>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => s.setShowAdd(true)} icon={<Plus className="h-5 w-5" />} className="rounded-full">{t("v4.experience.printers.manual")}</Button>
          <Button variant="primary" onClick={s.handleDiscover} loading={s.printersLoading} icon={<RefreshCw className="h-5 w-5" />} className="rounded-full">{t("desktop.printers.discover")}</Button>
          <Button variant="ghost" onClick={s.refreshPrinters} loading={s.printersLoading || s.localPrintersLoading} icon={<RefreshCw className="h-5 w-5" />} className="rounded-full">{t("desktop.printers.refresh")}</Button>
        </div>
      </Toolbar>

      {s.printersError && !s.printersLoading && <ErrorState title={t("desktop.printers.loadFailed")} message={s.printersError} retry={s.refreshPrinters} />}
      {s.localPrintersError && <ErrorState title={t("desktop.printers.localInventoryFailed")} message={s.localPrintersError} retry={() => void s.refreshLocalPrinters()} />}

      {pendingLocal.length > 0 && (
        <Card className="overflow-hidden rounded-2xl">
          <CardHeader title={t("desktop.printers.localPendingTitle")} subtitle={t("desktop.printers.localPendingBody", { count: pendingLocal.length })} />
          <details open>
          <summary className="cursor-pointer px-5 pb-3 text-sm font-semibold text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{t("desktop.printers.details")}</summary>
          <ul className="divide-y divide-edge-subtle lg:hidden">
            {pendingLocal.map((p) => (
              <li key={`local-${p.id}`} className="min-w-0 space-y-2 p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 break-words text-base font-semibold text-ink">
                      <span>{printerDisplayName(p, locale)}</span>
                      {isVirtualPrinter(p) && <VirtualBadge locale={locale} />}
                    </div>
                  </div>
                  <StatusBadge tone="warn" label={t("desktop.printers.waitingForSync")} />
                </div>
                <div className="break-words text-xs text-ink-3">{humanConnection(p, locale)}</div>
                <StatusDetailLine p={p} locale={locale} />
                <PrinterAvailabilityControl s={s} printer={p} candidate />
              </li>
            ))}
          </ul>
          <div className="hidden min-w-0 overflow-x-auto lg:block">
            <table className="data-table w-full text-base">
              <thead><tr className="border-y border-edge bg-surface-2/70 text-start text-xs font-[550] text-ink-3"><th className="px-5 py-2.5">{t("desktop.printers.colPrinter")}</th><th className="px-4 py-2.5">{t("desktop.printers.colConnection")}</th><th className="px-5 py-2.5">{t("desktop.printers.colConfig")}</th></tr></thead>
              <tbody>{pendingLocal.map((p) => (
                <tr key={`local-${p.id}`} className="border-b border-edge last:border-0">
                  <td className="px-5 py-3"><div className="flex flex-wrap items-center gap-2 font-semibold text-ink"><span>{printerDisplayName(p, locale)}</span>{isVirtualPrinter(p) && <VirtualBadge locale={locale} />}</div></td>
                  <td className="px-4 py-3 text-ink-2">{humanConnection(p, locale)}</td>
                  <td className="px-5 py-3"><div className="space-y-2"><StatusBadge tone="warn" label={t("desktop.printers.waitingForSync")} /><StatusDetailLine p={p} locale={locale} /><PrinterAvailabilityControl s={s} printer={p} candidate /></div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          </details>
        </Card>
      )}

      <Card className="overflow-hidden rounded-2xl">
        <CardHeader title={<span className="flex flex-wrap items-center gap-2.5">{t("desktop.printers.title")}<span className="min-w-0 max-w-full rounded-full border border-edge bg-surface-2 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-ink-3 [overflow-wrap:anywhere]">{t("desktop.printers.total", { count: total })}</span></span>} subtitle={t("desktop.printers.subtitle")} icon={<PrinterIcon className="h-4 w-4 text-brand" />} />
        {(s.printersLoading || s.localPrintersLoading) && rows.length === 0 ? <div className="p-5" role="status" aria-busy="true"><LoadingState rows={5} /></div> : rows.length === 0 && s.printersError ? null : rows.length === 0 ? (
          <EmptyState icon={<PrinterIcon className="h-8 w-8" />} title={total === 0 && s.statusFilter === "saved" ? t("printer.presentation.savedEmpty") : total === 0 && pendingLocal.length > 0 ? t("desktop.printers.waitingTitle") : total === 0 ? t("desktop.printers.emptyTitle") : t("desktop.printers.noMatches")} description={total === 0 && s.statusFilter === "saved" ? t("printer.presentation.savedEmptyBody") : total === 0 && pendingLocal.length > 0 ? t("desktop.printers.waitingBody") : total === 0 ? t("desktop.printers.emptyBody") : t("desktop.printers.noMatchesBody")} action={total === 0 && s.statusFilter !== "saved" ? <><Button variant="primary" onClick={s.handleDiscover} loading={s.printersLoading} icon={<RefreshCw className="h-5 w-5" />}>{t("desktop.printers.discoverPrinters")}</Button><Button variant="secondary" onClick={() => s.setShowAdd(true)} icon={<Plus className="h-5 w-5" />}>{t("v4.experience.printers.manual")}</Button></> : total > 0 ? <Button variant="secondary" onClick={() => { s.setPrintersFilter(""); s.setStatusFilter("all"); }}>{t("desktop.printers.allStatuses")}</Button> : undefined} />
        ) : (
          <>
          <ul className="divide-y divide-edge-subtle xl:hidden" aria-label={t("desktop.printers.title")}>
            {rows.map((p) => {
              const view = printerPresentation(p, undefined, nowMs);
              const name = printerDisplayName(p, locale);
              const virtual = isVirtualPrinter(p);
              return (
              <li key={p.id} className="min-w-0 px-4 py-4 transition-colors hover:bg-surface-hover/70 sm:px-5">
                <div className="flex min-w-0 items-start gap-3">
                  <PrinterAvatar name={name} size="lg" tone={view.tone} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="block max-w-full text-start text-base font-semibold text-ink [overflow-wrap:anywhere]">{name}</div>
                      {virtual && <VirtualBadge locale={locale} />}
                    </div>
                    <div className="mt-1 text-xs text-ink-3">{p.agentName || t("printer.unknownAgent")}</div>
                  </div>
                </div>
                <div className="mt-2.5 flex min-w-0 flex-wrap gap-1.5">
                  <StatusBadge tone={view.tone} label={t(view.labelKey)} />
                </div>
                <StatusDetailLine p={p} locale={locale} />
                <div className="mt-3 flex min-w-0 flex-wrap gap-2 border-t border-edge-subtle pt-3">
                  <Button size="sm" variant="secondary" onClick={() => s.setSelectedPrinter(p)} aria-label={`${t("desktop.printers.details")} — ${name}`} icon={<Eye className="h-5 w-5" />}>{t("desktop.printers.details")}</Button>
                </div>
                <div className="mt-3"><PrinterAvailabilityControl s={s} printer={p} /></div>
              </li>
              );
            })}
          </ul>
          <div className="hidden min-w-0 overflow-x-auto xl:block">
            <table className="data-table w-full text-base">
              <thead><tr className="border-y border-edge bg-surface-2/70 text-start text-xs font-[550] text-ink-3"><th className="px-5 py-2.5">{t("desktop.printers.colPrinter")}</th><th className="px-4 py-2.5">{t("common.status")}</th><th className="px-5 py-2.5 text-end">{t("desktop.printers.colActions")}</th></tr></thead>
              <tbody>{rows.map((p) => {
                const view = printerPresentation(p, undefined, nowMs);
                const name = printerDisplayName(p, locale);
                const virtual = isVirtualPrinter(p);
                return (
                <tr key={p.id} className="border-b border-edge last:border-0 hover:bg-surface-2/50 transition-colors">
                  <td className="px-5 py-3.5"><div className="flex items-center gap-3"><PrinterAvatar name={name} size="lg" tone={view.tone} /><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => s.setSelectedPrinter(p)} aria-label={`${t("desktop.printers.details")} — ${name}`} className="max-w-full break-words text-start text-base font-semibold text-ink hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{name}</button>{virtual && <VirtualBadge locale={locale} />}</div><div className="mt-0.5 text-xs text-ink-3">{p.agentName || t("printer.unknownAgent")}</div></div></div></td>
                  <td className="px-4 py-3.5"><StatusBadge tone={view.tone} label={t(view.labelKey)} /><StatusDetailLine p={p} locale={locale} /></td>
                  <td className="px-5 py-3.5"><div className="flex flex-wrap items-center justify-end gap-1.5">
                     <Button size="sm" variant="ghost" onClick={() => s.setSelectedPrinter(p)} aria-label={`${t("desktop.printers.details")} — ${name}`} icon={<Eye className="h-5 w-5" />}>{t("desktop.printers.details")}</Button>
                   </div><div className="mt-2 max-w-md ms-auto space-y-2"><PrinterAvailabilityControl s={s} printer={p} /></div></td>
                </tr>
                );
              })}</tbody>
            </table>
          </div>
          </>
        )}
        {!s.printersLoading && rows.length > 0 && s.statusFilter !== "saved" && <div className="flex flex-wrap items-center gap-4 border-t border-edge/80 bg-surface-2/35 px-5 py-3.5 text-xs text-ink-3">{(["ready", "printing", "attention", "unavailable"] as const).map((state) => <span key={state} className="inline-flex items-center gap-1.5 tabular-nums"><StatusDot tone={state === "ready" ? "ok" : state === "printing" ? "info" : state === "attention" ? "bad" : "neutral"} />{t(`printer.presentation.${state}Count`, { count: counts[state] })}</span>)}<span className="ms-auto inline-flex items-center gap-3 text-xs"><span className="rounded-full border border-edge/80 bg-surface px-2.5 py-0.5 font-medium text-ink-2 tabular-nums">{t("desktop.printers.sharedWithOdooCount", { shared: sharedCount, total: productionPrinters.length })}</span><span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" aria-hidden /> {t("desktop.printers.encrypted")}</span></span></div>}
      </Card>
    </div>
  );
}
