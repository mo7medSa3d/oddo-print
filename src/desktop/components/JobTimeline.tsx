import React from "react";
import { deriveOutcome, jobLabel } from "../lib/printers";
import { useI18n } from "../../i18n/react";

type TimelineProps = {
  status: string;
  error?: string | null;
  claimedAt?: string | null;
  deliveredAt?: string | null;
  ackedAt?: string | null;
};

/**
 * Queued → Claimed → Printing → Outcome pipeline for a print job.
 *
 * Steps are marked reached from EVIDENCE (delivery timestamps, the status,
 * and unknown-outcome markers), not from the terminal state alone:
 * a job that failed pre-dispatch never shows "Claimed ✓ Printing ✓" like a
 * job that really printed. In particular an ambiguous failure (e.g.
 * UNKNOWN_PARTIAL_DELIVERY from a delivery attempt alone) marks later steps
 * reached only when delivery evidence exists — otherwise the stages stay
 * unreached and the outcome reads uncertain (C039).
 */
export function JobTimeline({ status, error = null, claimedAt = null, deliveredAt = null, ackedAt = null }: TimelineProps) {
  const { t, locale } = useI18n();
  const s = String(status).toLowerCase();
  const outcome = deriveOutcome(s, error);
  const done = s === "success";
  const failed = s === "failed" || s === "expired";
  const unknown = outcome === "unknown";
  const delivered = Boolean(deliveredAt ?? ackedAt);

  const reachedQueued = true;
  const reachedClaimed = Boolean(claimedAt) || ["claimed", "printing", "success"].includes(s) || (failed && unknown && delivered);
  const reachedPrinting = ["printing", "success"].includes(s) || (failed && unknown && delivered);

  // `id` is the stable identity the logic compares against; `label` is what
  // the operator reads, so it follows the active language.
  const steps = [
    { id: "queued", label: t("desktop.timeline.queued"), reached: reachedQueued },
    { id: "claimed", label: t("desktop.timeline.claimed"), reached: reachedClaimed },
    { id: "printing", label: t("desktop.timeline.printing"), reached: reachedPrinting },
  ].map((step, i) => {
    const current =
      (step.id === "claimed" && s === "claimed") ||
      (step.id === "printing" && s === "printing");
    return {
      ...step,
      current,
      state: current && !done && !(failed || unknown) ? "current" : step.reached ? "done" : "todo",
      n: i + 1,
    } as const;
  });

  const terminalLabel = done || failed || unknown ? jobLabel(s, outcome, locale) : t("desktop.timeline.outcome");
  const terminalTone = done ? "ok" : unknown ? "warn" : failed ? "bad" : "todo";

  const fullSteps = [
    ...steps.map((step) => ({
      label: step.label,
      state: step.state as string,
    })),
    { label: terminalLabel, state: terminalTone === "todo" ? "todo" : terminalTone === "ok" ? "done" : "attention" },
  ];
  const srSummary = fullSteps
    .map((step, i) =>
      t("desktop.timeline.step", {
        index: i + 1,
        total: fullSteps.length,
        label: step.label,
        state:
          step.state === "done"
            ? t("desktop.timeline.state.completed")
            : step.state === "current"
              ? t("desktop.timeline.state.inProgress")
              : step.state === "todo"
                ? t("desktop.timeline.state.notReached")
                : t("desktop.timeline.state.needsAttention"),
      }),
    )
    .join(". ");

  return (
    <div
      className="rounded-xl border border-edge-accent bg-surface-accent px-5 py-4"
      role="group"
      aria-label={t("desktop.timeline.aria", { summary: srSummary })}
    >
      <ol className="flex items-start" aria-hidden="true">
        {steps.map((step, i) => (
          <li key={step.label} className="flex flex-1 items-start">
            {i > 0 && (
              <span
                aria-hidden
                className={`mt-[13px] h-0.5 flex-1 ${steps[i - 1].reached && step.reached ? "bg-ok-solid/50" : "bg-edge-strong"}`}
              />
            )}
            <span className="flex flex-col items-center gap-2 px-1" aria-hidden>
              <span
                className={`flex h-[26px] w-[26px] items-center justify-center rounded-sm border text-xs font-bold transition-colors ${
                  step.state === "current"
                    ? "border-brand bg-brand text-brand-contrast shadow-[var(--focus-ring-shadow)]"
                    : step.state === "done"
                    ? "border-ok-edge bg-ok-solid text-on-solid"
                    : "border-edge-strong bg-surface text-ink-4"
                }`}
              >
                {step.state === "done" ? "✓" : step.n}
              </span>
              <span
                className={`min-w-max text-center text-xs font-semibold ${
                  step.state === "current"
                    ? "text-ink"
                    : step.state === "done"
                    ? "text-ok"
                    : "text-ink-3"
                }`}
              >
                {step.label}
              </span>
            </span>
          </li>
        ))}
        <li className="flex flex-1 items-start">
          <span
            aria-hidden
            className={`mt-[13px] h-0.5 flex-1 ${done || failed || unknown ? "bg-ok-solid/50" : "bg-edge-strong"}`}
          />
          <span className="flex flex-col items-center gap-2 px-1" aria-hidden>
            <span
              className={`flex h-[26px] w-[26px] items-center justify-center rounded-sm border text-xs font-bold transition-colors ${
                terminalTone === "ok"
                  ? "border-ok-edge bg-ok-solid text-on-solid"
                  : terminalTone === "warn"
                  ? "border-warn-edge bg-warn-solid text-on-solid"
                  : terminalTone === "bad"
                  ? "border-bad-edge bg-bad-solid text-on-solid"
                  : "border-edge-strong bg-surface text-ink-4"
              }`}
            >
              {done ? "✓" : failed || unknown ? (unknown ? "?" : "✕") : ""}
            </span>
            <span
              className={`min-w-max text-center text-xs font-semibold ${
                terminalTone === "ok" ? "text-ok" : terminalTone === "bad" ? "text-bad" : terminalTone === "warn" ? "text-warn" : "text-ink-3"
              }`}
            >
              {terminalLabel}
            </span>
          </span>
        </li>
      </ol>
    </div>
  );
}
