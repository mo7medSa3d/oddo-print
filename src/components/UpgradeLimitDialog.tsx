"use client";

import { ArrowUpRight, CircleAlert } from "lucide-react";
import Link from "next/link";
import { Modal } from "./ui";
import { useI18n } from "../i18n/react";
import type { MessageKey } from "../i18n/messages/en";

export type UpgradeLimitResource = "agents" | "printers" | "prints" | "rate" | "concurrency";

const COPY: Record<UpgradeLimitResource, { title: MessageKey; unit: MessageKey; description: MessageKey }> = {
  agents: {
    title: "limit.title.agents",
    unit: "limit.unit.agents",
    description: "limit.description.agents",
  },
  printers: {
    title: "limit.title.printers",
    unit: "limit.unit.printers",
    description: "limit.description.printers",
  },
  prints: {
    title: "limit.title.prints",
    unit: "limit.unit.prints",
    description: "limit.description.prints",
  },
  rate: {
    title: "limit.title.rate",
    unit: "limit.unit.rate",
    description: "limit.description.rate",
  },
  concurrency: {
    title: "limit.title.concurrency",
    unit: "limit.unit.concurrency",
    description: "limit.description.concurrency",
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
  retryAfterSeconds?: number | null;
}) {
  const { t, tc, formatNumber, formatDate } = useI18n();
  const copy = COPY[resource];
  const usedText = typeof used === "number" ? formatNumber(used) : "—";
  const limitText = limit === "unlimited" ? t("limit.unlimited") : typeof limit === "number" ? formatNumber(limit) : "—";
  const end = periodEnd ? new Date(periodEnd) : null;
  const periodText = end && !Number.isNaN(end.getTime()) ? formatDate(end) : null;
  const retryMinutes = typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
    ? Math.max(1, Math.ceil(retryAfterSeconds / 60))
    : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(copy.title)}
      description={t("limit.modalDescription")}
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-sg border border-warn-edge bg-warn-bg px-4 py-3.5 text-sm text-warn">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="leading-relaxed">{t(copy.description)}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-sg border border-edge bg-surface-2 px-4 py-3.5">
            <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-4">{t("limit.used")}</div>
            <div className="mt-1.5 text-xl font-bold tabular-nums text-ink">{usedText}</div>
          </div>
          <div className="rounded-sg border border-edge bg-surface-2 px-4 py-3.5">
            <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-4">{t("limit.planLimit")}</div>
            <div className="mt-1.5 text-xl font-bold tabular-nums text-ink">{limitText}</div>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-ink-3">
          {resource === "prints"
            ? t("limit.note.prints")
            : resource === "rate"
              ? t("limit.note.rate")
              : resource === "concurrency"
                ? t("limit.note.concurrency")
                : t("limit.note.capacity", { limit: limitText, unit: t(copy.unit) })}
          {periodText ? ` ${t("limit.note.periodEnds", { date: periodText })}` : ""}
          {retryMinutes ? ` ${tc("limit.note.retryMinutes", retryMinutes, { count: retryMinutes })}` : ""}
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded-sm border border-edge-strong bg-surface-2 px-4 text-sm font-semibold text-ink-2 transition hover:bg-surface-3 hover:text-ink"
          >
            {t("ui.closeDialog")}
          </button>
          <Link
            href="/billing"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-sm bg-brand px-4 text-sm font-semibold text-brand-contrast transition hover:bg-brand-hover"
          >
            {t("limit.upgradePlan")}
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </Modal>
  );
}
