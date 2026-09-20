import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, Inbox, Printer as PrinterIcon, RefreshCw, Search, Trash2, X, XCircle, ShieldCheck } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, Mono, StatusBadge, Tabs } from "../../components/ui";
import type { DesktopState } from "../types";
import { cleanupLocalJobs } from "../lib/ipc";
import { friendlyPrinterError, jobDestination, jobDocType, jobId, jobPrinterId, jobStatus, labelJob, toneJob } from "../lib/printers";

const TABS = ["all", "in_flight", "queued", "unassigned", "printed", "failed", "unknown", "expired"] as const;

export function JobsPage({ s }: { s: DesktopState }) {
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const tabCounts = { all: s.jobCounts.all, queued: s.jobCounts.queued, in_flight: s.jobCounts.in_flight, unassigned: s.jobCounts.unassigned, printed: s.jobCounts.printed, unknown: s.jobCounts.unknown, failed: s.jobCounts.failed, expired: s.jobCounts.expired };

  const handleCleanup = async () => {
    setCleanupBusy(true);
    try {
      const deleted = await cleanupLocalJobs();
      setCleanupOpen(false);
      s.setMsg({ text: deleted === 0 ? "No completed or failed local jobs to remove." : `Removed ${deleted} terminal job${deleted === 1 ? "" : "s"}.`, type: "success" });
    } catch (error) { s.setMsg({ text: error instanceof Error ? error.message : "Failed to clean local jobs", type: "error" }); }
    finally { setCleanupBusy(false); }
  };

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <div className="px-2"><Tabs tabs={TABS} active={s.jobTab} onChange={s.setJobTab} counts={tabCounts} /></div>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden /><Input value={s.jobSearch} onChange={(e) => s.setJobSearch(e.target.value)} placeholder="Search job, document or printer…" className="pl-10 h-10 rounded-[10px]" aria-label="Search jobs" /></div>
          <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => { void s.refreshJobs(); }} loading={s.jobsLoading} icon={<RefreshCw className="h-4 w-4" />} className="h-10 rounded-[10px]">Refresh</Button><Button variant="ghost" onClick={() => setCleanupOpen(true)} disabled={cleanupBusy} icon={<Trash2 className="h-4 w-4" />} className="h-10">Clean local</Button></div>
        </div>
        {s.jobPrinterFilter && (
          <div className="flex items-center gap-3 border-t border-edge bg-brand-subtle px-5 py-3">
            <span className="inline-flex items-center gap-2 rounded-[10px] border border-edge-accent bg-surface px-3 py-1.5 text-[12px] font-medium text-brand"><PrinterIcon className="h-4 w-4" /> Filtered to <Mono className="text-inherit">{s.printerFilterName}</Mono><button onClick={() => s.setJobPrinterFilter(null)} aria-label={`Clear filter ${s.printerFilterName}`} className="ml-1 rounded p-0.5 hover:bg-surface-2"><X className="h-4 w-4" /></button></span>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        {s.jobsLoading ? <div className="p-5"><LoadingState rows={5} /></div> : s.jobsError ? <div className="p-5"><ErrorState title="Jobs unavailable" message={s.jobsError} retry={() => { void s.refreshJobs(); }} /></div> : s.jobsFiltered.length === 0 ? (
          <EmptyState icon={s.jobTab === "failed" ? <XCircle className="h-8 w-8 text-bad" /> : s.jobTab === "unknown" ? <AlertTriangle className="h-8 w-8 text-warn" /> : s.jobTab === "printed" ? <CheckCircle2 className="h-8 w-8 text-ok" /> : <Inbox className="h-8 w-8" />} title={s.jobPrinterFilter ? `No jobs for ${s.printerFilterName}` : s.jobTab === "all" ? "No print jobs yet" : `No ${s.jobTab} jobs`} description={s.jobPrinterFilter ? "Clear filter to see full queue." : s.jobTab === "failed" ? "Failed jobs appear here with reason and printer." : s.jobTab === "queued" ? "Queued jobs waiting for agent." : "Print jobs will appear here."} action={s.jobPrinterFilter ? <Button variant="secondary" onClick={() => s.setJobPrinterFilter(null)} icon={<X className="h-4 w-4" />}>Clear filter</Button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="border-b border-edge bg-surface-2 text-left text-[11px] uppercase tracking-wide text-ink-3"><th className="px-5 py-2.5">Document</th><th className="px-4 py-2.5">Job ID</th><th className="px-4 py-2.5">Printer</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Created</th><th className="px-4 py-2.5">Updated</th><th className="px-5 py-2.5 text-right">Actions</th></tr></thead>
              <tbody>{s.jobsFiltered.map((j) => (
                <tr key={jobId(j)} className="border-b border-edge last:border-0 hover:bg-surface-2/50"><td className="px-5 py-3"><div className="text-[13px] font-semibold text-ink">{jobDocType(j)}</div>{jobDestination(j) ? <div className="text-[11px] text-ink-3">{jobDestination(j)}</div> : null}</td><td className="px-4 py-3"><Mono>{jobId(j)}</Mono></td><td className="px-4 py-3 text-ink-2">{String(s.printers.find((p) => p.id === jobPrinterId(j))?.name || jobPrinterId(j) || "—")}</td><td className="px-4 py-3"><StatusBadge tone={toneJob(jobStatus(j), j.error)} label={labelJob(jobStatus(j), j.error)} /></td><td className="px-4 py-3 text-[11px] text-ink-3 tabular-nums">{j.createdAt ? new Date(String(j.createdAt)).toLocaleString() : "—"}</td><td className="px-4 py-3 text-[11px] text-ink-3 tabular-nums">{j.updatedAt ? new Date(String(j.updatedAt)).toLocaleString() : "—"}</td><td className="px-5 py-3 text-right"><Button size="sm" variant="secondary" onClick={() => s.setSelectedJob(j)} icon={<Eye className="h-3.5 w-3.5" />}>Details</Button></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={cleanupOpen} onClose={() => { if (!cleanupBusy) setCleanupOpen(false); }} title="Clean local print jobs?" description="Clears terminal records from this PC's local Agent queue." footer={<><Button variant="secondary" onClick={() => setCleanupOpen(false)} disabled={cleanupBusy}>Cancel</Button><Button variant="danger" onClick={handleCleanup} loading={cleanupBusy} icon={<Trash2 className="h-4 w-4" />}>Clean local jobs</Button></>}>
        <div className="space-y-3 text-[13px] text-ink-2"><p>Only completed and provably-failed local records are removed.</p><p>Queued, printing, and <strong>unknown-outcome</strong> records are kept — evidence that a document may already have printed. Check printer, then clear via CLI with <span className="font-mono text-[11px] bg-surface-2 px-1.5 py-0.5 rounded border border-edge">jobs cleanup --include-unknown</span>.</p><p className="text-[11px] text-ink-3">Gateway PostgreSQL history is not changed.</p></div>
      </Modal>
    </div>
  );
}
