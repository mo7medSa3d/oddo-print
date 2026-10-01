"use client";

import { useState } from "react";
import { Button } from "./ui";
import { CheckCircle2, CircleAlert, ExternalLink, Printer } from "lucide-react";

type StepStatus = "ok" | "error" | "blocked" | "pending" | "running";
type CertificationStep = {
  id: string;
  label: string;
  description: string;
  status: StepStatus;
  at?: string | null;
  message?: string;
  evidence?: string;
};

const statusMeta: Record<StepStatus, { label: string; classes: string }> = {
  ok: { label: "Passed", classes: "bg-ok-bg text-ok border-ok-edge" },
  error: { label: "Failed", classes: "bg-bad-bg text-bad border-bad-edge" },
  blocked: { label: "Blocked", classes: "bg-warn-bg text-warn border-warn-edge" },
  running: { label: "Running", classes: "bg-info-bg text-info border-info-edge" },
  pending: { label: "Pending", classes: "bg-surface-3 text-ink-2 border-edge" },
};

function formatTime(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString();
}

export default function PrintCertificationWizard({ printerId }: { printerId: string }) {
  const [steps, setSteps] = useState<CertificationStep[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [certified, setCertified] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timelineUrl, setTimelineUrl] = useState<string | null>(null);

  async function runCertification() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/printers/${printerId}/certify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testPage: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSteps(data.steps);
      setJobId(data.jobId);
      setRequestId(data.requestId);
      setCertified(data.certified);
      setBlocked(data.blocked);
      setTimelineUrl(data.timelineUrl ?? (data.jobId ? `/api/jobs/${data.jobId}/timeline` : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const completedCount = steps?.filter((step) => step.status === "ok").length ?? 0;
  const failedCount = steps?.filter((step) => step.status === "error").length ?? 0;
  const blockedCount = steps?.filter((step) => step.status === "blocked").length ?? 0;

  return (
    <div className="space-y-4">
      <section className="rounded-[10px] border border-edge bg-surface-2 px-5 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-ink-3">
              <Printer className="h-4 w-4 shrink-0" aria-hidden />
              <span className="text-[12px] font-semibold uppercase tracking-[0.08em]">Printer certification</span>
            </div>
            <h3 className="mt-2 text-[17px] font-semibold tracking-[-0.01em] text-ink">Verify the complete print path</h3>
            <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-ink-2">
              Yaseir sends a controlled test page and reports the result of each stage, from Gateway authentication and queueing through agent transport and physical printing.
            </p>
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={runCertification}
            loading={loading}
            disabled={loading}
            icon={<Printer className="h-4 w-4" aria-hidden />}
            className="shrink-0"
          >
            {loading ? "Running certification…" : steps ? "Run again" : "Run certification"}
          </Button>
        </div>

        {error && (
          <div role="alert" className="mt-4 rounded-[10px] border border-bad-edge bg-bad-bg px-4 py-3">
            <div className="flex gap-2.5">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-bad" aria-hidden />
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-bad">Certification could not be completed</div>
                <p className="mt-1 break-words text-[13px] leading-relaxed text-ink-2">{error}</p>
              </div>
            </div>
          </div>
        )}
      </section>

      {steps && (
        <>
          <section aria-label="Certification summary" className="grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-edge bg-edge sm:grid-cols-3">
            <div className="bg-surface px-4 py-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Overall result</div>
              <div className="mt-1.5 flex items-center gap-2 text-[15px] font-semibold text-ink">
                <span
                  aria-hidden
                  className={`h-2 w-2 rounded-full ${certified ? "bg-ok-solid" : blocked ? "bg-warn-solid" : "bg-bad-solid"}`}
                />
                {certified ? "Certified" : blocked ? "Blocked" : "Review required"}
              </div>
              <div className="mt-1 text-[12px] text-ink-3">
                {certified
                  ? "All stages passed."
                  : blocked
                    ? `${blockedCount} blocked · ${failedCount} failed`
                    : `${failedCount} failed · ${blockedCount} blocked`}
              </div>
            </div>
            <div className="bg-surface px-4 py-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Stages passed</div>
              <div className="mt-1.5 text-[15px] font-semibold tabular-nums text-ink">
                {completedCount} <span className="text-[13px] font-normal text-ink-3">of {steps.length}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-[8px] bg-surface-3" role="progressbar" aria-valuenow={completedCount} aria-valuemin={0} aria-valuemax={steps.length} aria-label="Stages passed">
                <div className="h-full rounded-[8px] bg-brand" style={{ width: `${steps.length ? Math.round((completedCount / steps.length) * 100) : 0}%` }} />
              </div>
            </div>
            <div className="bg-surface px-4 py-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Print job</div>
              <div className="mt-1.5 truncate font-mono text-[12px] text-ink" title={jobId ?? undefined}>
                {jobId ?? "Not created"}
              </div>
              <div className="mt-1 truncate text-[12px] text-ink-3" title={requestId ?? undefined}>
                {requestId ? `Request ${requestId.slice(0, 12)}…` : "No request recorded"}
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-[10px] border border-edge bg-surface">
            <div className="border-b border-edge bg-surface-2 px-5 py-3.5">
              <h4 className="text-[14px] font-semibold text-ink">Certification stages</h4>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">Each stage is reported independently so failures and blocked physical steps are unambiguous.</p>
            </div>

            <ol className="divide-y divide-edge">
              {steps.map((step, index) => {
                const meta = statusMeta[step.status];
                const time = formatTime(step.at);
                return (
                  <li key={step.id} className="px-5 py-4">
                    <div className="flex gap-3.5">
                      <div
                        aria-hidden
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-edge bg-surface-2 text-[13px] font-semibold tabular-nums text-ink-2"
                      >
                        {step.status === "ok" ? <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden /> : index + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <h5 className="text-[14px] font-semibold leading-snug text-ink">{step.label}</h5>
                            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{step.description}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className={`inline-flex items-center rounded-[6px] border px-2 py-0.5 text-[12px] font-semibold ${meta.classes}`}>{meta.label}</span>
                            {time && <span className="text-[12px] tabular-nums text-ink-3">{time}</span>}
                          </div>
                        </div>

                        {step.message && (
                          <p className="mt-2.5 rounded-[8px] border border-edge bg-surface-2 px-3.5 py-2.5 text-[14px] leading-relaxed text-ink-2">
                            {step.message}
                          </p>
                        )}

                        {step.evidence && (
                          <div className="mt-2.5 overflow-hidden rounded-[8px] border border-edge bg-app">
                            <div className="border-b border-edge px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Evidence</div>
                            <code className="block max-h-48 overflow-auto whitespace-pre-wrap break-words px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-ink-2">{step.evidence}</code>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section aria-label="Physical verification" className="rounded-[10px] border border-warn-edge bg-warn-bg px-4 py-3.5">
            <div className="flex gap-2.5">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
              <div className="min-w-0">
                <h4 className="text-[13px] font-semibold text-ink">Physical print verification</h4>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                  In staging without a physical printer, the Physical stage may be BLOCKED by design. On real hardware, confirm that the YASEIR test page reaches paper output and that the Gateway job links to the Windows spooler result before treating certification as complete.
                </p>
              </div>
            </div>
          </section>

          {(requestId || timelineUrl || failedCount > 0) && (
            <section aria-label="Certification references" className="rounded-[10px] border border-edge bg-surface px-4 py-3.5">
              <dl className="grid gap-3 sm:grid-cols-2">
                {requestId && (
                  <div className="min-w-0">
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Request ID</dt>
                    <dd className="mt-1 break-all font-mono text-[12px] text-ink-2">{requestId}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Failed stages</dt>
                  <dd className={`mt-1 text-[13px] font-semibold tabular-nums ${failedCount > 0 ? "text-bad" : "text-ink"}`}>{failedCount}</dd>
                </div>
              </dl>
              {timelineUrl && (
                <a href={timelineUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 rounded-[6px] text-[13px] font-semibold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25">
                  View job timeline
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
