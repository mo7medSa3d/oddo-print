import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle, CheckCircle2, Clock3, Eye, FileCheck2, FileText,
  LoaderCircle, Maximize2, ShieldCheck, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { Button } from "../../components/ui";
import { useI18n } from "../../i18n/react";
import type { E2ECaptureRun, E2ECaptureStatus } from "../lib/ipc";

const statusMeta = {
  queued: { icon: Clock3, className: "border-warn-edge bg-warn-bg text-warn", key: "desktop.testCenter.remoteStatus.queued" },
  claimed: { icon: LoaderCircle, className: "border-brand/25 bg-brand-subtle text-brand", key: "desktop.testCenter.remoteStatus.claimed" },
  rendered_locally: { icon: CheckCircle2, className: "border-ok-edge bg-ok-bg text-ok", key: "desktop.testCenter.remoteStatus.rendered_locally" },
  failed: { icon: AlertCircle, className: "border-bad-edge bg-bad-bg text-bad", key: "desktop.testCenter.remoteStatus.failed" },
  expired: { icon: Clock3, className: "border-edge bg-surface-2 text-ink-3", key: "desktop.testCenter.remoteStatus.expired" },
} as const satisfies Record<E2ECaptureStatus, { icon: typeof Clock3; className: string; key: string }>;

export function CaptureHistory({
  rows, onPreview,
}: {
  rows: E2ECaptureRun[];
  onPreview: (run: E2ECaptureRun) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div role="list" className="space-y-3">
      {rows.map((run) => {
        const meta = statusMeta[run.status] ?? statusMeta.failed;
        const Icon = meta.icon;
        const isReceipt = run.paperMm === 58 || run.paperMm === 80;
        const title = isReceipt
          ? t("desktop.testCenter.inboxReceipt", { width: run.paperMm })
          : t("desktop.testCenter.inboxPdf");
        return (
          <article role="listitem" key={run.runId}
            className="group min-w-0 rounded-2xl border border-edge bg-surface px-4 py-4 shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-2/40 sm:px-5">
            <div className="flex min-w-0 flex-wrap items-start gap-3 sm:gap-4">
              <div aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-edge bg-surface-2 text-brand">
                {run.status === "rendered_locally" ? <FileCheck2 className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h4 className="break-words text-base font-semibold text-ink">{title}</h4>
                  <span className={`inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold leading-normal ${meta.className}`}>
                    <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
                    {t(meta.key)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                  <time dateTime={run.createdAt}>
                    {new Date(run.createdAt).toLocaleString(locale === "ar" ? "ar-EG" : "en-US", { dateStyle: "medium", timeStyle: "short" })}
                  </time>
                  <span dir="ltr" className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs">{run.runId.slice(-8)}</span>
                  {run.pages ? <span>{t("desktop.testCenter.inboxPageCount", { count: run.pages })}</span> : null}
                  {run.pdfBytes ? <span>{(run.pdfBytes / 1024).toFixed(1)} KB</span> : null}
                </div>
                {run.errorCode && (
                  <p className="break-words text-xs text-bad" dir="ltr" aria-label={t("desktop.testCenter.inboxFailureReason")}>
                    {run.errorCode}
                  </p>
                )}
              </div>
              {run.status === "rendered_locally" && (
                <Button size="sm" variant="secondary"
                  className="min-h-10 shrink-0"
                  icon={<Eye className="h-4 w-4" aria-hidden />}
                  onClick={() => onPreview(run)}>
                  {t("desktop.testCenter.remotePreview")}
                </Button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

const zoomFactors = [0.7, 1, 1.25, 1.6, 2] as const;

export function CapturePreviewDialog({
  run, image, loading, error, onClose,
}: {
  run: E2ECaptureRun | null;
  image: string | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [fit, setFit] = useState(true);
  const [zoomIndex, setZoomIndex] = useState(1);
  const width = run?.paperMm === 58 ? 260 : run?.paperMm === 80 ? 356 : 675;
  const scaledWidth = Math.round(width * zoomFactors[zoomIndex]);
  const setZoom = (delta: number) => {
    setFit(false);
    setZoomIndex((current) => Math.min(zoomFactors.length - 1, Math.max(0, current + delta)));
  };
  const close = () => {
    setFit(true);
    setZoomIndex(1);
    onClose();
  };
  return (
    <Dialog.Root open={Boolean(run)} onOpenChange={(open) => { if (!open) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-[3px]" />
        <Dialog.Content aria-describedby="capture-preview-description"
          className="fixed inset-3 z-[101] mx-auto flex max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl outline-none sm:inset-6 sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)]">
          <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-edge px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <FileCheck2 aria-hidden className="h-5 w-5 text-brand" />
                <Dialog.Title className="text-base font-semibold text-ink sm:text-lg">
                  {run?.paperMm === 58 || run?.paperMm === 80
                    ? t("desktop.testCenter.inboxReceipt", { width: run.paperMm })
                    : t("desktop.testCenter.previewDocumentTitle")}
                </Dialog.Title>
              </div>
              <Dialog.Description id="capture-preview-description" className="mt-1.5 text-xs leading-5 text-ink-3">
                {t("desktop.testCenter.previewFirstPage")}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label={t("desktop.testCenter.remoteClose")}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-edge text-ink-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                <X aria-hidden className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-edge bg-surface-2 px-3 py-2 sm:px-5">
                <span className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
                  <ShieldCheck aria-hidden className="h-4 w-4" />{t("desktop.testCenter.previewSimulation")}
                </span>
                <div className="flex items-center gap-1" role="group" aria-label={t("desktop.testCenter.previewZoom")}>
                  <button type="button" onClick={() => setZoom(-1)} disabled={!fit && zoomIndex === 0}
                    aria-label={t("desktop.testCenter.previewZoomOut")}
                    className="flex h-11 w-11 items-center justify-center rounded-lg text-ink-2 hover:bg-surface focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40">
                    <ZoomOut aria-hidden className="h-4 w-4" />
                  </button>
                  <span className="w-12 text-center font-mono text-xs tabular-nums text-ink-2">
                    {fit ? t("desktop.testCenter.previewFitShort") : `${Math.round(zoomFactors[zoomIndex] * 100)}%`}
                  </span>
                  <button type="button" onClick={() => setZoom(1)} disabled={!fit && zoomIndex === zoomFactors.length - 1}
                    aria-label={t("desktop.testCenter.previewZoomIn")}
                    className="flex h-11 w-11 items-center justify-center rounded-lg text-ink-2 hover:bg-surface focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40">
                    <ZoomIn aria-hidden className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => setFit(true)}
                    aria-label={t("desktop.testCenter.previewFit")}
                    className="ms-1 flex min-h-11 items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-2 text-sm font-medium text-ink-2 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand">
                    <Maximize2 aria-hidden className="h-3.5 w-3.5" />{t("desktop.testCenter.previewFitShort")}
                  </button>
                </div>
              </div>
              <div className="min-h-[220px] flex-1 overflow-auto overscroll-contain bg-surface-2 p-4 sm:p-7"
                role="region" tabIndex={0} aria-label={t("desktop.testCenter.previewDocumentTitle")}>
                {loading ? (
                  <div role="status" className="flex min-h-52 flex-col items-center justify-center gap-3 text-sm text-ink-3">
                    <LoaderCircle aria-hidden className="h-6 w-6 animate-spin" />
                    {t("desktop.testCenter.previewLoading")}
                  </div>
                ) : error ? (
                  <div role="alert" className="mx-auto max-w-sm rounded-xl border border-bad-edge bg-bad-bg p-5 text-sm text-bad">
                    <AlertCircle aria-hidden className="mb-2 h-5 w-5" />{error}
                  </div>
                ) : image ? (
                  <div className="flex min-w-full justify-center">
                    {/* This image is the bounded, Agent-scoped JPEG first-page
                        thumbnail. Never access private file:// capture paths. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image} alt={t("desktop.testCenter.previewImageAlt")}
                      className="h-auto shrink-0 self-start bg-white shadow-[0_16px_48px_rgba(0,0,0,.22)]"
                      style={fit ? { width: "100%", maxWidth: width } : { width: scaledWidth, maxWidth: "none" }} />
                  </div>
                ) : null}
              </div>
            </div>

            <aside className="shrink-0 border-t border-edge bg-surface px-5 py-5 lg:w-64 lg:overflow-y-auto lg:border-s lg:border-t-0">
              <h3 className="mb-4 text-sm font-semibold text-ink">{t("desktop.testCenter.previewDetails")}</h3>
              <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm lg:grid-cols-1">
                <div className="min-w-0">
                  <dt className="text-xs text-ink-3">{t("desktop.testCenter.previewState")}</dt>
                  <dd className="mt-1 font-semibold text-ok">{t("desktop.testCenter.remoteStatus.rendered_locally")}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-ink-3">{t("desktop.testCenter.pages")}</dt>
                  <dd className="mt-1 font-medium text-ink">{run?.pages ?? "—"}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-ink-3">{t("desktop.testCenter.bytes")}</dt>
                  <dd className="mt-1 font-medium text-ink">{run?.pdfBytes ? `${(run.pdfBytes / 1024).toFixed(1)} KB` : "—"}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-ink-3">{t("desktop.testCenter.previewCreated")}</dt>
                  <dd className="mt-1 break-words text-xs text-ink-2">
                    {run ? new Date(run.createdAt).toLocaleString(locale === "ar" ? "ar-EG" : "en-US", { dateStyle: "medium", timeStyle: "short" }) : "—"}
                  </dd>
                </div>
              </dl>
              <p className="mt-5 rounded-xl border border-edge bg-surface-2 p-3 text-xs leading-5 text-ink-3">
                {t("desktop.testCenter.remoteNotPrinted")}
              </p>
            </aside>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ClearCapturesDialog({
  open, onOpenChange, onConfirm, busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[105] bg-black/65" />
        <Dialog.Content aria-describedby="capture-cleanup-description"
          className="fixed left-1/2 top-1/2 z-[106] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-edge bg-surface p-6 shadow-2xl outline-none">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-bad-edge bg-bad-bg text-bad">
            <AlertCircle aria-hidden className="h-6 w-6" />
          </div>
          <Dialog.Title className="text-lg font-semibold text-ink">
            {t("desktop.testCenter.clearConfirmTitle")}
          </Dialog.Title>
          <Dialog.Description id="capture-cleanup-description" className="mt-3 space-y-2 text-sm leading-6 text-ink-2">
            {t("desktop.testCenter.clearConfirmBody")}
          </Dialog.Description>
          <p className="mt-3 text-xs text-ink-3">{t("desktop.testCenter.clearConfirmRecent")}</p>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
              {t("desktop.testCenter.clearCancel")}
            </Button>
            <Button variant="danger" loading={busy} disabled={busy} onClick={onConfirm}>
              {t("desktop.testCenter.clearConfirmAction")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
