"use client";

import { useState } from "react";
import {
  Button,
  Callout,
  Mono,
  Progress,
  Skeleton,
  StatusBadge,
  type Tone,
} from "./ui";
import { useI18n } from "../i18n/react";
import type { MessageKey } from "../i18n/messages/en";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  ExternalLink,
  Loader2,
  MinusCircle,
  Printer,
  ShieldCheck,
  XCircle,
} from "lucide-react";

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

const STEP_STATUS_KEYS: Record<StepStatus, MessageKey> = {
  ok: "cert.status.passed",
  error: "cert.status.failed",
  blocked: "cert.status.blocked",
  running: "cert.status.running",
  pending: "cert.status.pending",
};

const STEP_TONES: Record<StepStatus, Tone> = {
  ok: "ok",
  error: "bad",
  blocked: "warn",
  running: "info",
  pending: "neutral",
};

/**
 * The certification API keeps sending human-readable `label`/`description`
 * fields (contract preserved); the UI renders the semantic copy for the step
 * id instead and only falls back to the payload for unknown steps.
 */
const STEP_KEYS: Record<string, { label: MessageKey; description: MessageKey }> = {
  gateway: { label: "cert.step.gateway", description: "cert.step.gateway.desc" },
  auth: { label: "cert.step.auth", description: "cert.step.auth.desc" },
  queue: { label: "cert.step.queue", description: "cert.step.queue.desc" },
  claim: { label: "cert.step.claim", description: "cert.step.claim.desc" },
  agent: { label: "cert.step.agent", description: "cert.step.agent.desc" },
  transport: { label: "cert.step.transport", description: "cert.step.transport.desc" },
  physical: { label: "cert.step.physical", description: "cert.step.physical.desc" },
  ack: { label: "cert.step.ack", description: "cert.step.ack.desc" },
  final: { label: "cert.step.final", description: "cert.step.final.desc" },
};

function stepLabel(step: CertificationStep, t: (key: MessageKey) => string): string {
  const keys = STEP_KEYS[step.id];
  return keys ? t(keys.label) : step.label;
}

function stepDescription(step: CertificationStep, t: (key: MessageKey) => string): string {
  const keys = STEP_KEYS[step.id];
  return keys ? t(keys.description) : step.description;
}

function StepStatusIcon({ status }: { status: StepStatus }) {
  if (status === "ok") return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />;
  if (status === "error") return <XCircle className="h-3.5 w-3.5" aria-hidden />;
  if (status === "blocked") return <MinusCircle className="h-3.5 w-3.5" aria-hidden />;
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />;
  return <Clock className="h-3.5 w-3.5" aria-hidden />;
}

function toDateOrNull(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Guided printer certification.
 *
 * Runs the same real test print as before (`POST /api/printers/:id/certify`)
 * and reports every stage independently, so a blocked physical step stays
 * distinguishable from a failed transport step. Status is always icon + label.
 */
export default function PrintCertificationWizard({ printerId }: { printerId: string }) {
  const { t, formatNumber, formatTime } = useI18n();
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
      if (!res.ok) throw new Error(t("cert.failedBody"));
      setSteps(data.steps);
      setJobId(data.jobId);
      setRequestId(data.requestId);
      setCertified(data.certified);
      setBlocked(data.blocked);
      setTimelineUrl(data.timelineUrl ?? (data.jobId ? `/api/jobs/${data.jobId}/timeline` : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("cert.failedBody"));
    } finally {
      setLoading(false);
    }
  }

  const completedCount = steps?.filter((step) => step.status === "ok").length ?? 0;
  const failedCount = steps?.filter((step) => step.status === "error").length ?? 0;
  const blockedCount = steps?.filter((step) => step.status === "blocked").length ?? 0;
  const overallTone: Tone = certified ? "ok" : blocked ? "warn" : "bad";

  return (
    <div className="space-y-4">
      <section className="rounded-sg border border-edge bg-surface-2 px-4 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="label-caps flex items-center gap-2">
              <Printer className="h-3.5 w-3.5" aria-hidden />
              {t("cert.eyebrow")}
            </div>
            <h3 className="mt-2 text-xl font-[640] tracking-[-0.02em] text-ink">
              {t("cert.heading")}
            </h3>
            <p className="mt-1.5 max-w-2xl text-base leading-relaxed text-ink-2">
              {t("cert.intro")}
            </p>
          </div>
          <Button
            variant="primary"
            onClick={runCertification}
            loading={loading}
            disabled={loading}
            icon={<Printer className="h-4 w-4" aria-hidden />}
            className="shrink-0"
          >
            {loading ? t("cert.runningCta") : steps ? t("cert.runAgain") : t("cert.run")}
          </Button>
        </div>

        {error && (
          <Callout tone="bad" title={t("cert.failedTitle")} className="mt-4">
            <span role="alert" className="break-words">{error}</span>
          </Callout>
        )}
      </section>

      {!steps && !loading && (
        <section className="rounded-sg border border-dashed border-edge-strong bg-surface px-5 py-8 text-center">
          <span aria-hidden className="mx-auto flex h-9 w-9 items-center justify-center rounded-md border border-edge bg-surface-2 text-ink-3">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <p className="mt-3 text-base font-[600] text-ink">{t("cert.emptyTitle")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-ink-3">
            {t("cert.emptyBody")}
          </p>
        </section>
      )}

      {loading && !steps && (
        <section className="space-y-2.5 rounded-sg border border-edge bg-surface px-5 py-5" role="status" aria-label={t("cert.loadingAria")}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-7 w-7 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3 w-72 max-w-full" />
              </div>
            </div>
          ))}
          <span className="sr-only">{t("cert.runningCta")}</span>
        </section>
      )}

      {steps && (
        <>
          <section
            aria-label={t("cert.summaryAria")}
            className="grid grid-cols-1 gap-px overflow-hidden rounded-sg border border-edge bg-edge sm:grid-cols-3"
          >
            <div className="bg-surface px-4 py-3.5">
              <div className="label-caps">{t("cert.overallResult")}</div>
              <div className="mt-1.5 flex items-center gap-2">
                <StatusBadge
                  tone={overallTone}
                  label={certified ? t("cert.result.certified") : blocked ? t("cert.result.blocked") : t("cert.result.review")}
                />
              </div>
              <div className="mt-1.5 text-sm text-ink-3">
                {certified
                  ? t("cert.allStagesPassed")
                  : blocked
                    ? t("cert.blockedSummary", { blocked: formatNumber(blockedCount), failed: formatNumber(failedCount) })
                    : t("cert.failedSummary", { failed: formatNumber(failedCount), blocked: formatNumber(blockedCount) })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3.5">
              <div className="label-caps">{t("cert.stagesPassed")}</div>
              <div className="mt-1.5 text-md font-[600] tabular-nums text-ink">
                {formatNumber(completedCount)} <span className="text-sm font-normal text-ink-3">{t("cert.ofTotal", { total: formatNumber(steps.length) })}</span>
              </div>
              <Progress
                className="mt-2"
                value={steps.length ? Math.round((completedCount / steps.length) * 100) : 0}
                tone={certified ? "ok" : failedCount > 0 ? "bad" : blockedCount > 0 ? "warn" : "brand"}
                label={t("cert.progressLabel", { done: formatNumber(completedCount), total: formatNumber(steps.length) })}
              />
            </div>
            <div className="bg-surface px-4 py-3.5">
              <div className="label-caps">{t("cert.printJob")}</div>
              <div className="mt-1.5">
                {jobId ? <Mono className="block truncate">{jobId}</Mono> : <span className="text-sm text-ink-3">{t("cert.jobNotCreated")}</span>}
              </div>
              <div className="mt-1 truncate text-sm text-ink-3" title={requestId ?? undefined}>
                {requestId ? t("cert.requestShort", { id: requestId.slice(0, 12) }) : t("cert.noRequestRecorded")}
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-sg border border-edge bg-surface">
            <div className="border-b border-edge-subtle bg-surface-2 px-4 py-3">
              <h4 className="text-base font-[600] text-ink">{t("cert.stagesHeading")}</h4>
              <p className="mt-0.5 text-sm leading-relaxed text-ink-3">
                {t("cert.stagesBody")}
              </p>
            </div>

            <ol className="divide-y divide-edge-subtle">
              {steps.map((step, index) => {
                const tone = STEP_TONES[step.status] ?? STEP_TONES.pending;
                const at = toDateOrNull(step.at);
                const time = at ? formatTime(at) : null;
                return (
                  <li key={step.id} className="px-4 py-4">
                    <div className="flex gap-3.5">
                      <div
                        aria-hidden
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-[600] tabular-nums ${
                          step.status === "ok"
                            ? "border-ok-edge bg-ok-bg text-ok"
                            : step.status === "error"
                              ? "border-bad-edge bg-bad-bg text-bad"
                              : step.status === "blocked"
                                ? "border-warn-edge bg-warn-bg text-warn"
                                : "border-edge bg-surface-2 text-ink-3"
                        }`}
                      >
                        {step.status === "ok" ? <CheckCircle2 className="h-4 w-4" /> : index + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <h5 className="text-base font-[600] leading-snug text-ink">{stepLabel(step, t)}</h5>
                            <p className="mt-0.5 text-sm leading-relaxed text-ink-3">{stepDescription(step, t)}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <StatusBadge
                              size="sm"
                              tone={tone}
                              label={t(STEP_STATUS_KEYS[step.status] ?? STEP_STATUS_KEYS.pending)}
                              icon={<StepStatusIcon status={step.status} />}
                            />
                            {time && <span className="text-xs tabular-nums text-ink-3">{time}</span>}
                          </div>
                        </div>

                        {step.message && (
                          <p className="mt-2.5 rounded-sm border border-edge bg-surface-2 px-3.5 py-2.5 text-[14px] leading-relaxed text-ink-2">
                            {step.message}
                          </p>
                        )}

                        {step.evidence && (
                          <div className="mt-2.5 overflow-hidden rounded-sm border border-edge bg-app">
                            <div className="label-caps border-b border-edge-subtle px-3.5 py-2">{t("cert.evidence")}</div>
                            <code className="block max-h-48 overflow-auto whitespace-pre-wrap break-words px-3.5 py-2.5 font-mono text-xs leading-relaxed text-ink-2">
                              {step.evidence}
                            </code>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <Callout tone="warn" title={t("cert.physicalTitle")}>
            {t("cert.physicalBody")}
          </Callout>

          {(requestId || timelineUrl || failedCount > 0) && (
            <section aria-label={t("cert.referencesAria")} className="rounded-sg border border-edge bg-surface px-4 py-3.5">
              <dl className="grid gap-3 sm:grid-cols-2">
                {requestId && (
                  <div className="min-w-0">
                    <dt className="label-caps">{t("cert.requestId")}</dt>
                    <dd className="mt-1 break-all">
                      <Mono>{requestId}</Mono>
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="label-caps">{t("cert.failedStages")}</dt>
                  <dd className={`mt-1 text-base font-[600] tabular-nums ${failedCount > 0 ? "text-bad" : "text-ink"}`}>
                    {formatNumber(failedCount)}
                  </dd>
                </div>
              </dl>
              {timelineUrl && (
                <a
                  href={timelineUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-xs text-sm font-[550] text-brand transition-colors duration-[140ms] hover:text-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
                >
                  {t("cert.viewTimeline")}
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
