"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Loader2, MinusCircle } from "lucide-react";
import { Mono, Skeleton, StatusBadge, type Tone } from "./ui";

type TimelineEvent = {
  id: string;
  stage: string;
  status: string;
  at?: string;
  message?: string;
  errorCode?: string;
  attemptId?: string;
  claimId?: string;
  spoolerJobId?: string;
  agentId?: string;
  printerId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

type Correlation = Record<string, string | null | undefined>;

const STAGE_LABELS: Record<string, string> = {
  created: "Job created",
  queued: "Queued for an agent",
  claimed: "Claimed by agent",
  accepted: "Accepted by agent",
  connection: "Printer connection",
  printing: "Printing",
  delivery: "Delivery to spooler",
  success: "Completed",
  failed: "Failed",
  expired: "Expired",
  blocked: "Blocked",
};

function stageTone(status: string): Tone {
  switch (status) {
    case "ok": return "ok";
    case "error": return "bad";
    case "blocked": return "warn";
    default: return "neutral";
  }
}

function stageLabel(status: string): string {
  switch (status) {
    case "ok": return "Success";
    case "error": return "Error";
    case "blocked": return "Blocked";
    case "pending": return "Pending";
    default: return status;
  }
}

function StageIcon({ status }: { status: string }) {
  if (status === "ok") return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />;
  if (status === "error") return <AlertTriangle className="h-3.5 w-3.5" aria-hidden />;
  if (status === "blocked") return <MinusCircle className="h-3.5 w-3.5" aria-hidden />;
  return <Clock className="h-3.5 w-3.5" aria-hidden />;
}

function formatWhen(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Print-job lifecycle timeline.
 *
 * Reads the same `/api/jobs/:id/timeline` payload as before; the presentation
 * layer adds semantic status (icon + label, never colour alone), correlation
 * identifiers and a retry path for transient failures.
 */
export default function JobTimeline({ jobId }: { jobId: string }) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [correlation, setCorrelation] = useState<Correlation | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/timeline`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (controller.signal.aborted) return;
        setEvents(Array.isArray(data.timeline) ? data.timeline : []);
        setCorrelation((data.correlation ?? null) as Correlation | null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [jobId, reloadKey]);

  if (loading) {
    return (
      <div className="space-y-3" role="status" aria-label="Loading job timeline">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="h-6 w-6 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
          </div>
        ))}
        <span className="sr-only">Loading timeline…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-sg border border-bad-edge bg-bad-bg px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2.5 text-sm text-bad">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Timeline unavailable — {error}</span>
        </div>
        <button
          type="button"
          onClick={retry}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 self-start rounded-sm border border-bad-edge bg-surface px-3 text-sm font-[550] text-bad transition-colors duration-[140ms] hover:bg-bad-bg sm:self-auto"
        >
          <Loader2 className="h-3.5 w-3.5" aria-hidden />
          Retry
        </button>
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-sg border border-dashed border-edge-strong bg-surface-2 px-5 py-8 text-center">
        <Clock className="h-5 w-5 text-ink-4" aria-hidden />
        <p className="text-base font-[550] text-ink">No timeline events yet</p>
        <p className="max-w-sm text-sm leading-relaxed text-ink-3">
          Lifecycle events appear here as the gateway queues, claims, prints and reconciles this job.
        </p>
      </div>
    );
  }

  const correlated = correlation
    ? Object.entries(correlation).filter(([, value]) => Boolean(value))
    : [];

  return (
    <div className="space-y-4">
      {correlated.length > 0 && (
        <dl className="rounded-sg border border-edge bg-surface-2 px-3.5 py-3">
          <div className="label-caps">Correlation IDs</div>
          <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {correlated.map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-ink-3">{key}</dt>
                <dd className="min-w-0">
                  <Mono className="block truncate">{String(value).slice(0, 32)}</Mono>
                </dd>
              </div>
            ))}
          </div>
        </dl>
      )}

      <ol className="relative space-y-4 ps-7">
        <span className="absolute start-[9px] top-2 bottom-2 w-px bg-edge" aria-hidden />
        {events.map((ev) => {
          const tone = stageTone(ev.status);
          const when = formatWhen(ev.at);
          return (
            <li key={ev.id} className="relative">
              <span
                aria-hidden
                className={`absolute -start-7 top-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border ${
                  tone === "ok"
                    ? "border-ok-edge bg-ok-bg text-ok"
                    : tone === "bad"
                      ? "border-bad-edge bg-bad-bg text-bad"
                      : tone === "warn"
                        ? "border-warn-edge bg-warn-bg text-warn"
                        : "border-edge bg-surface-2 text-ink-3"
                }`}
              >
                <StageIcon status={ev.status} />
              </span>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-base font-[550] text-ink">
                  {STAGE_LABELS[ev.stage] ?? ev.stage}
                </span>
                <StatusBadge size="sm" tone={tone} label={stageLabel(ev.status)} />
                {when && <span className="text-xs tabular-nums text-ink-4">{when}</span>}
              </div>
              {ev.message && <p className="mt-1 text-sm leading-relaxed text-ink-2">{ev.message}</p>}
              {ev.errorCode && (
                <p className="mt-1 text-xs text-ink-3">
                  Error code <Mono>{ev.errorCode}</Mono>
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {ev.attemptId && (
                  <span className="text-xs text-ink-4">
                    attempt <Mono>{ev.attemptId.slice(0, 12)}</Mono>
                  </span>
                )}
                {ev.claimId && (
                  <span className="text-xs text-ink-4">
                    claim <Mono>{ev.claimId.slice(0, 8)}…</Mono>
                  </span>
                )}
                {ev.spoolerJobId && (
                  <span className="text-xs text-ink-4">
                    spooler <Mono className="text-ink-2">{ev.spoolerJobId}</Mono>
                  </span>
                )}
                {ev.requestId && (
                  <span className="text-xs text-ink-4">
                    request <Mono>{ev.requestId.slice(0, 12)}</Mono>
                  </span>
                )}
              </div>
              {ev.metadata && Object.keys(ev.metadata).length > 0 && (
                <details className="group mt-2">
                  <summary className="cursor-pointer list-none text-xs font-[550] text-ink-3 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
                    Technical details
                  </summary>
                  <pre className="mt-1.5 max-h-40 overflow-auto rounded-sm border border-edge bg-surface-2 p-2.5 text-xs leading-relaxed text-ink-2">
                    {JSON.stringify(ev.metadata, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
