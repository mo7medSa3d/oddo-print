"use client";

import { ArrowUpRight, CircleAlert } from "lucide-react";
import Link from "next/link";
import { Modal } from "./ui";

export type UpgradeLimitResource = "agents" | "printers" | "prints" | "rate" | "concurrency";

const COPY: Record<UpgradeLimitResource, { title: string; unit: string; description: string }> = {
  agents: {
    title: "Agent limit reached",
    unit: "active agents",
    description: "Your current plan has reached its active Agent capacity. Upgrade the plan to pair another Agent.",
  },
  printers: {
    title: "Printer limit reached",
    unit: "active printers",
    description: "Your current plan has reached its printer capacity. Upgrade the plan to provision another printer.",
  },
  prints: {
    title: "Print limit reached",
    unit: "print jobs",
    description: "Your current plan has used its included print jobs for this billing period. Upgrade the plan to continue creating new print jobs.",
  },
  rate: {
    title: "Print rate limit reached",
    unit: "jobs per minute",
    description: "Your current plan has reached its print throughput limit. New jobs will be accepted again when the rolling limit clears.",
  },
  concurrency: {
    title: "Concurrent print limit reached",
    unit: "active print jobs",
    description: "Your current plan has reached its active print-job capacity. Wait for in-flight jobs to finish or upgrade the plan.",
  },
};

export default function UpgradeLimitDialog({
  open,
  onClose,
  resource,
  used,
  limit,
  periodEnd,
  retryAfterSeconds,
}: {
  open: boolean;
  onClose: () => void;
  resource: UpgradeLimitResource;
  used?: number | null;
  limit?: number | "unlimited" | null;
  periodEnd?: string | Date | null;
}) {
  const copy = COPY[resource];
  const usedText = typeof used === "number" ? used.toLocaleString() : "—";
  const limitText = limit === "unlimited" ? "Unlimited" : typeof limit === "number" ? limit.toLocaleString() : "—";
  const end = periodEnd ? new Date(periodEnd) : null;
  const periodText = end && !Number.isNaN(end.getTime())
    ? end.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.title}
      description="The Gateway enforces plan limits server-side, so no new print operation or resource is admitted beyond the plan allowance."
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-[12px] border border-warn-edge bg-warn-bg px-4 py-3.5 text-[13px] text-warn">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="leading-relaxed">{copy.description}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-[12px] border border-edge bg-surface-2 px-4 py-3.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-4">Used</div>
            <div className="mt-1.5 text-[18px] font-bold tabular-nums text-ink">{usedText}</div>
          </div>
          <div className="rounded-[12px] border border-edge bg-surface-2 px-4 py-3.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-4">Plan limit</div>
            <div className="mt-1.5 text-[18px] font-bold tabular-nums text-ink">{limitText}</div>
          </div>
        </div>

        <p className="text-[12px] leading-relaxed text-ink-3">
          {resource === "prints"
            ? "Metering unit: 1 admitted Gateway print job = 1 print credit."
            : resource === "rate"
              ? "This is a rolling 60-second limit, not a calendar-minute allowance."
              : resource === "concurrency"
                ? "This limit counts queued, claimed, and actively printing jobs."
                : `Current capacity: ${limitText} ${copy.unit}.`}
          {periodText ? ` The current billing period ends ${periodText}.` : ""}
          {typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
            ? ` Try again in about ${Math.ceil(retryAfterSeconds / 60)} minute${Math.ceil(retryAfterSeconds / 60) === 1 ? "" : "s"}.`
            : ""}
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded-full border border-edge-strong bg-surface-2 px-4 text-[13px] font-semibold text-ink-2 transition hover:bg-surface-3 hover:text-ink"
          >
            Close
          </button>
          <Link
            href="/billing"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-brand px-4 text-[13px] font-semibold text-brand-contrast transition hover:bg-brand-hover"
          >
            Upgrade plan
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </Modal>
  );
}
