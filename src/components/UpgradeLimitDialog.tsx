"use client";

import { ArrowUpRight, CircleAlert } from "lucide-react";
import { useState } from "react";
import { Button, Modal } from "./ui";
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
  copyBillingDestination,
}: {
  open: boolean;
  onClose: () => void;
  resource: UpgradeLimitResource;
  used?: number | null;
  limit?: number | "unlimited" | null;
  periodEnd?: string | Date | null;
  retryAfterSeconds?: number | null;
  /** Desktop: never navigate WebView to /billing; give a validated copyable origin URL. */
  copyBillingDestination?: { url: string | null };
}) {
  const { t, tc, formatNumber, formatDate } = useI18n();
  const copy = COPY[resource];
  const billingUrl = copyBillingDestination?.url ?? null;
  const [copiedUrl, setCopiedUrl] = useState("");
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
        <div className="flex items-start gap-3 rounded-md border border-warn-edge bg-warn-bg px-4 py-3.5 text-sm text-warn">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="leading-relaxed">{t(copy.description)}</p>
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-edge bg-edge-subtle">
          <div className="bg-surface-2 px-4 py-3.5">
            <div className="text-xs font-[550] text-ink-3">{t("limit.used")}</div>
            <div className="mt-1.5 text-xl font-bold tabular-nums text-ink">{usedText}</div>
          </div>
          <div className="bg-surface-2 px-4 py-3.5">
            <div className="text-xs font-[550] text-ink-3">{t("limit.planLimit")}</div>
            <div className="mt-1.5 text-xl font-bold tabular-nums text-ink">{limitText}</div>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-ink-3">
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
          <Button variant="secondary" onClick={onClose}>
            {t("ui.closeDialog")}
          </Button>
          {copyBillingDestination ? (
            billingUrl ? (
              <div className="flex min-w-0 flex-1 flex-col gap-2 sm:items-end">
                {/* A read-only selectable URL remains usable even if clipboard permission is denied. */}
                <input
                  className="w-full min-w-0 rounded-sm border border-edge bg-surface-2 px-2 py-1.5 text-xs text-ink"
                  aria-label={t("limit.copyBillingLink")}
                  value={billingUrl}
                  readOnly
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  variant="primary"
                  onClick={() => {
                    // navigator.clipboard is undefined in insecure contexts;
                    // optional chaining + catch keeps the manual-select input
                    // above as the fallback instead of throwing.
                    try {
                      void navigator.clipboard?.writeText(billingUrl).then(
                        () => setCopiedUrl(billingUrl),
                        () => setCopiedUrl(""),
                      );
                    } catch {
                      setCopiedUrl("");
                    }
                  }}
                >
                  {copiedUrl === billingUrl ? t("limit.linkCopied") : t("limit.copyBillingLink")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-warn">{t("limit.configureGatewayFirst")}</p>
            )
          ) : (
            <Button
              variant="primary"
              href="/billing"
              onClick={onClose}
              icon={<ArrowUpRight className="h-4 w-4" aria-hidden />}
            >
              {t("limit.upgradePlan")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
