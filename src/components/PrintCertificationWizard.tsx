"use client";

import { useState } from "react";
import { Button } from "./ui";
import { CheckCircle2, CircleAlert, ExternalLink, Loader2, Printer } from "lucide-react";

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

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-edge-strong bg-surface-2 p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-brand">
              <Printer className="h-5 w-5 shrink-0" aria-hidden />
              <span className="text-[12px] font-semibold uppercase tracking-[0.08em]">Printer certification</span>
            </div>
            <h3 className="mt-2 text-[20px] font-bold tracking-tight text-ink">Verify the complete print path</h3>
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
              Yasser sends a controlled test page and reports the result of each stage, from Gateway authentication and queueing through Agent transport and physical printing.
            </p>
          </div>
          <Button
            variant="primary"
            size="lg"
            onClick={runCertification}
            loading={loading}
            disabled={loading}
            icon={<Printer className="h-4 w-4" aria-hidden />}
          >
            {loading ? "Running certification…" : "Run certification"}
          </Button>
        </div>

        {error && (
          <div role="alert" className="mt-5 rounded-xl border border-bad-edge bg-bad-bg px-4 py-3.5">
            <div className="flex gap-3">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-bad" aria-hidden />
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-bad">Certification could not be completed</div>
                <p className="mt-1 break-words text-[13px] leading-relaxed text-ink-2">{error}</p>
              </div>
            </div>
          </div>
        )}
      </section>

      {steps && (
        <>
          <section className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Overall result</div>
              <div className="mt-2 text-[17px] font-bold text-ink">{certified ? "Certified" : blocked ? "Blocked" : "Review required"}</div>
            </div>
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Stages passed</div>
              <div className="mt-2 text-[17px] font-bold text-ink">{completedCount} <span className="text-[13px] font-medium text-ink-3">of {steps.length}</span></div>
            </div>
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Print job</div>
              <div className="mt-2 truncate font-mono text-[13px] font-semibold text-ink" title={jobId ?? undefined}>{jobId ?? "Not created"}</div>
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-edge-strong bg-surface">
            <div className="border-b border-edge bg-surface-2 px-5 py-4">
              <h4 className="text-[15px] font-semibold text-ink">Certification stages</h4>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-3">Each stage is reported independently so failures and blocked physical steps are unambiguous.</p>
            </div>

            <div className="divide-y divide-edge">
              {steps.map((step, index) => {
                const meta = statusMeta[step.status];
                const time = formatTime(step.at);
                return (
                  <article key={step.id} className="px-5 py-5 sm:px-6">
                    <div className="flex gap-4">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-edge bg-surface-2 text-[13px] font-bold text-ink">
                        {step.status === "ok" ? <CheckCircle2 className="h-5 w-5 text-ok" aria-hidden /> : index + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <h5 className="text-[15px] font-semibold leading-snug text-ink">{step.label}</h5>
                            <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{step.description}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${meta.classes}`}>{meta.label}</span>
                            {time && <span className="text-[12px] text-ink-4">{time}</span>}
                          </div>
                        </div>

                        {step.message && (
                          <div className="mt-3 rounded-xl border border-edge bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
                            {step.message}
                          </div>
                        )}

                        {step.evidence && (
                          <div className="mt-3 overflow-x-auto rounded-xl border border-edge bg-app px-4 py-3">
                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">Evidence</div>
                            <code className="block whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-2">{step.evidence}</code>
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-warn-edge bg-warn-bg p-5">
            <div className="flex gap-3">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
              <div>
                <h4 className="text-[14px] font-semibold text-warn">Physical print verification</h4>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                  In staging without a physical printer, the Physical stage may be BLOCKED by design. On real hardware, confirm that the YASSER test page reaches paper output and that the Gateway job links to the Windows Spooler result before treating certification as complete.
                </p>
              </div>
            </div>
          </section>

          {(requestId || timelineUrl || failedCount > 0) && (
            <section className="rounded-2xl border border-edge bg-surface-2 p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                {requestId && (
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Request ID</div>
                    <code className="mt-1 block break-all font-mono text-[12px] text-ink-2">{requestId}</code>
                  </div>
                )}
                {failedCount > 0 && (
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Failed stages</div>
                    <div className="mt-1 text-[13px] font-semibold text-bad">{failedCount}</div>
                  </div>
                )}
              </div>
              {timelineUrl && (
                <a href={timelineUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand hover:underline">
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
