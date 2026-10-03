import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, Inbox, Printer as PrinterIcon, RefreshCw, Search, Trash2, X, XCircle, ShieldCheck } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, Mono, StatusBadge, Tabs } from "../../components/ui";
import type { DesktopState } from "../types";
import { useI18n } from "../../i18n/react";
import { cleanupLocalJobs } from "../lib/ipc";
import { friendlyAgentError, friendlyPrinterError, jobDestination, jobDocType, jobId, jobPrinterId, jobStatus, jobTimestamp, labelJob, toneJob } from "../lib/printers";

const TABS = ["all", "in_flight", "queued", "unassigned", "delivered", "failed", "unknown", "expired"] as const;

/** Tab labels follow the active language; the ids stay stable for the URL hash. */
function useJobTabLabels() {
  const { t } = useI18n();
  return {
    all: t("desktop.jobs.tab.all"),
    in_flight: t("desktop.jobs.tab.in_flight"),
    queued: t("desktop.jobs.tab.queued"),
    unassigned: t("desktop.jobs.tab.unassigned"),
    delivered: t("desktop.jobs.tab.delivered"),
    failed: t("desktop.jobs.tab.failed"),
    unknown: t("desktop.jobs.tab.unknown"),
    expired: t("desktop.jobs.tab.expired"),
  };
}

export function JobsPage({ s }: { s: DesktopState }) {
  const { t, tc, locale, formatDateTime } = useI18n();
  const JOB_TAB_LABELS = useJobTabLabels();
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const tabCounts = { all: s.jobCounts.all, queued: s.jobCounts.queued, in_flight: s.jobCounts.in_flight, unassigned: s.jobCounts.unassigned, delivered: s.jobCounts.delivered, unknown: s.jobCounts.unknown, failed: s.jobCounts.failed, expired: s.jobCounts.expired };

  const handleCleanup = async () => {
    setCleanupBusy(true);
    try {
      const deleted = await cleanupLocalJobs();
      setCleanupOpen(false);
      s.setMsg({ text: deleted === 0 ? t("desktop.jobs.cleanupNone") : tc("desktop.jobs.cleanupRemoved", deleted), type: "success" });
    } catch (error) { s.setMsg({ text: friendlyAgentError(error instanceof Error ? error.message : t("desktop.jobs.cleanupFailed"), locale), type: "error" }); }
    finally { setCleanupBusy(false); }
  };

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <div className="px-2"><Tabs
          tabs={TABS}
          active={s.jobTab}
          onChange={s.setJobTab}
          counts={tabCounts}
          labels={JOB_TAB_LABELS}
        /></div>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden /><Input value={s.jobSearch} onChange={(e) => s.setJobSearch(e.target.value)} placeholder={t("desktop.jobs.searchPlaceholder")} className="ps-10 h-10 rounded-md" aria-label={t("desktop.jobs.searchAria")} /></div>
          <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => { void s.refreshJobs(); }} loading={s.jobsLoading} icon={<RefreshCw className="h-4 w-4" />} className="h-10 rounded-md">{t("desktop.jobs.refresh")}</Button><Button variant="ghost" onClick={() => setCleanupOpen(true)} disabled={cleanupBusy} icon={<Trash2 className="h-4 w-4" />} className="h-10">{t("desktop.jobs.cleanLocal")}</Button></div>
        </div>
        {s.jobPrinterFilter && (
          <div className="flex items-center gap-3 border-t border-edge bg-brand-subtle px-5 py-3">
            <span className="inline-flex items-center gap-2 rounded-md border border-edge-accent bg-surface px-3 py-1.5 text-xs font-medium text-brand"><PrinterIcon className="h-4 w-4" /> {t("desktop.jobs.filteredTo")} <Mono className="text-inherit">{s.printerFilterName}</Mono><button onClick={() => s.setJobPrinterFilter(null)} aria-label={t("desktop.jobs.clearFilterAria", { name: s.printerFilterName })} className="ms-1 rounded p-0.5 hover:bg-surface-2"><X className="h-4 w-4" /></button></span>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        {s.jobsLoading ? <div className="p-5"><LoadingState rows={5} /></div> : s.jobsError ? <div className="p-5"><ErrorState title={t("desktop.jobs.unavailable")} message={s.jobsError} retry={() => { void s.refreshJobs(); }} /></div> : s.jobsFiltered.length === 0 ? (
          <EmptyState icon={s.jobTab === "failed" ? <XCircle className="h-8 w-8 text-bad" /> : s.jobTab === "unknown" ? <AlertTriangle className="h-8 w-8 text-warn" /> : s.jobTab === "delivered" ? <CheckCircle2 className="h-8 w-8 text-ok" /> : <Inbox className="h-8 w-8" />} title={s.jobPrinterFilter ? t("desktop.jobs.emptyForPrinter", { name: s.printerFilterName }) : s.jobTab === "all" ? t("desktop.jobs.emptyAll") : t("desktop.jobs.emptyForTab", { tab: JOB_TAB_LABELS[s.jobTab] })} description={s.jobPrinterFilter ? t("desktop.jobs.emptyFilteredBody") : s.jobTab === "failed" ? t("desktop.jobs.emptyFailedBody") : s.jobTab === "queued" ? t("desktop.jobs.emptyQueuedBody") : t("desktop.jobs.emptyDefaultBody")} action={s.jobPrinterFilter ? <Button variant="secondary" onClick={() => s.setJobPrinterFilter(null)} icon={<X className="h-4 w-4" />}>{t("desktop.jobs.clearFilter")}</Button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-edge bg-surface-2 text-start text-2xs uppercase tracking-wide text-ink-3"><th className="px-5 py-2.5">{t("desktop.jobs.colDocument")}</th><th className="hidden px-4 py-2.5 lg:table-cell">{t("desktop.jobs.colJobId")}</th><th className="px-4 py-2.5">{t("desktop.jobs.colPrinter")}</th><th className="px-4 py-2.5">{t("desktop.jobs.colStatus")}</th><th className="hidden px-4 py-2.5 lg:table-cell">{t("desktop.jobs.colCreated")}</th><th className="px-4 py-2.5">{t("desktop.jobs.colUpdated")}</th><th className="px-5 py-2.5 text-end">{t("desktop.jobs.colActions")}</th></tr></thead>
              <tbody>{s.jobsFiltered.map((j) => (
                <tr key={jobId(j)} className="border-b border-edge last:border-0 hover:bg-surface-2/50"><td className="px-5 py-3"><div className="text-sm font-semibold text-ink">{jobDocType(j, locale)}</div>{jobDestination(j) ? <div className="text-2xs text-ink-3">{jobDestination(j)}</div> : null}</td><td className="hidden px-4 py-3 lg:table-cell"><Mono>{jobId(j)}</Mono></td><td className="px-4 py-3 text-ink-2">{String(s.printers.find((p) => p.id === jobPrinterId(j))?.name || jobPrinterId(j) || "—")}</td><td className="px-4 py-3"><StatusBadge tone={toneJob(jobStatus(j), j.error)} label={labelJob(jobStatus(j), j.error, locale)} /></td><td className="hidden px-4 py-3 text-2xs text-ink-3 tabular-nums lg:table-cell">{formatDateTime(jobTimestamp(j, "createdAt"))}</td><td className="px-4 py-3 text-2xs text-ink-3 tabular-nums">{formatDateTime(jobTimestamp(j, "updatedAt"))}</td><td className="px-5 py-3 text-end"><Button size="sm" variant="secondary" onClick={() => s.setSelectedJob(j)} icon={<Eye className="h-3.5 w-3.5" />}>{t("desktop.jobs.details")}</Button></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={cleanupOpen} onClose={() => { if (!cleanupBusy) setCleanupOpen(false); }} title={t("desktop.jobs.cleanupTitle")} description={t("desktop.jobs.cleanupDescription")} footer={<><Button variant="secondary" onClick={() => setCleanupOpen(false)} disabled={cleanupBusy}>{t("common.cancel")}</Button><Button variant="danger" onClick={handleCleanup} loading={cleanupBusy} icon={<Trash2 className="h-4 w-4" />}>{t("desktop.jobs.cleanupConfirm")}</Button></>}>
        <div className="space-y-3 text-sm text-ink-2"><p>{t("desktop.jobs.cleanupBody1")}</p><p>{t("desktop.jobs.cleanupBody2a")} {t("desktop.jobs.cleanupBody2b")}</p><p className="text-2xs text-ink-3">{t("desktop.jobs.cleanupBody3")}</p></div>
      </Modal>
    </div>
  );
}
