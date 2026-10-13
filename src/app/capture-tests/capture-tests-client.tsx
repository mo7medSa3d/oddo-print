"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle, CheckCircle2, ChevronDown, ClipboardCheck, Clock3,
  Eye, FileCheck2, FileClock, FileText, LoaderCircle, Monitor,
  RefreshCw, Server, ShieldCheck, Trash2, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { Button, StatusBadge, type Tone } from "../../components/ui";
import { fetchWithTimeout } from "../../lib/fetch-timeout";
import { useI18n } from "../../i18n/react";

type CaptureState = "queued" | "claimed" | "rendered_locally" | "failed" | "expired";
type Cursor = { beforeCreatedAt: string; beforeId: string };
type TestEntry = {
  runId: string;
  agentId: string;
  agentName: string | null;
  status: CaptureState;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  paperMm: number;
  pages: number | null;
  pdfBytes: number | null;
  errorCode: string | null;
  previewAvailable: boolean;
  gatewayReceived: true;
  agentReceived: boolean;
};
type CaptureSnapshot = {
  gatewayCaptureEnabled: boolean;
  simulationOnly: true;
  physicalPrinted: false;
  agents: Array<{ id: string; name: string }>;
  summary: {
    gatewayReceived: number;
    agentReceived: number;
    rendered: number;
    waiting: number;
    failed: number;
  };
  items: TestEntry[];
  hasMore: boolean;
  nextCursor: Cursor | null;
};
type Deletion = { scope: "finished" } | { scope: "one"; runId: string };
type Notice = { count: number; hasMoreEligible: boolean };

const states: CaptureState[] = ["queued", "claimed", "rendered_locally", "failed", "expired"];
const statesUI: Record<CaptureState, { label: "captureMonitor.queued" | "captureMonitor.claimed" | "captureMonitor.rendered" | "captureMonitor.failed" | "captureMonitor.expired"; tone: Tone }> = {
  queued: { label: "captureMonitor.queued", tone: "warn" },
  claimed: { label: "captureMonitor.claimed", tone: "info" },
  rendered_locally: { label: "captureMonitor.rendered", tone: "ok" },
  failed: { label: "captureMonitor.failed", tone: "bad" },
  expired: { label: "captureMonitor.expired", tone: "neutral" },
};

function isFinished(run: TestEntry) {
  return run.status === "rendered_locally" || run.status === "failed" || run.status === "expired";
}
function paramsFor(agent: string, cursor: Cursor | null) {
  const params = new URLSearchParams({ limit: "50" });
  if (agent !== "all") params.set("agentId", agent);
  if (cursor) {
    params.set("beforeCreatedAt", cursor.beforeCreatedAt);
    params.set("beforeId", cursor.beforeId);
  }
  return "/api/test-captures?" + params.toString();
}
async function readError(response: Response): Promise<string> {
  const data = await response.json().catch(() => null) as { code?: string } | null;
  return typeof data?.code === "string" ? data.code : "INTERNAL_ERROR";
}

export default function CaptureTestsClient({
  canPreview, canDelete,
}: {
  canPreview: boolean;
  canDelete: boolean;
}) {
  const { t, formatDateTime, formatBytes, formatNumber } = useI18n();
  const [snapshot, setSnapshot] = useState<CaptureSnapshot | null>(null);
  const [rows, setRows] = useState<TestEntry[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [agentFilter, setAgentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<CaptureState | "all">("all");
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deletion, setDeletion] = useState<Deletion | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [previewRun, setPreviewRun] = useState<TestEntry | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);

  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const expanded = useRef(false);
  const previewGeneration = useRef(0);

  const load = useCallback(async (older: boolean, pageCursor: Cursor | null = null) => {
    // Never let a slow auto-refresh overwrite a newer manual request or
    // the next page. A single request controller owns the full response body.
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++generation.current;
    setPaging(older);
    setLoading(!older);
    try {
      const response = await fetchWithTimeout(paramsFor(agentFilter, older ? pageCursor : null), {
        credentials: "include", cache: "no-store", signal: controller.signal,
      }, 12_000);
      if (!response.ok) throw new Error(await readError(response));
      const next = (await response.json()) as CaptureSnapshot;
      if (!Array.isArray(next.items) || !Array.isArray(next.agents) || !next.summary) {
        throw new Error("INVALID_RESPONSE");
      }
      if (controller.signal.aborted || current !== generation.current) return;
      setRows((prev) => older
        ? [...prev, ...next.items.filter(row => !prev.some(x => x.runId === row.runId))]
        : next.items);
      setCursor(next.nextCursor);
      setSnapshot(next);
      setError("");
    } catch (cause) {
      if (!controller.signal.aborted && current === generation.current) {
        setError(cause instanceof Error ? cause.message : "INTERNAL_ERROR");
      }
    } finally {
      if (current === generation.current) {
        setPaging(false);
        setLoading(false);
      }
    }
  }, [agentFilter]);

  useEffect(() => {
    const generationRef = generation;
    const requestRef = request;
    const expandedRef = expanded;
    expandedRef.current = false;
    // Schedule the initial network read after effect setup. The async load
    // updates state only from its request callback, not synchronously inside
    // the effect (and can be canceled before it starts).
    const initial = window.setTimeout(() => void load(false), 0);
    const interval = window.setInterval(() => {
      if (!document.hidden && !expandedRef.current) void load(false);
    }, 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      generationRef.current++;
      requestRef.current?.abort();
    };
  }, [load]);

  const visible = useMemo(() => statusFilter === "all"
    ? rows : rows.filter(row => row.status === statusFilter), [rows, statusFilter]);

  const openPreview = async (run: TestEntry) => {
    if (!canPreview || !run.previewAvailable || run.status !== "rendered_locally") return;
    const n = ++previewGeneration.current;
    setPreviewRun(run);
    setPreviewImage(null);
    setPreviewError("");
    setPreviewBusy(true);
    setZoom(null);
    try {
      const response = await fetchWithTimeout(
        "/api/test-captures/preview?id=" + encodeURIComponent(run.runId),
        { credentials: "include", cache: "no-store" }, 12_000,
      );
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json() as { previewDataUri?: string };
      if (!data.previewDataUri?.startsWith("data:image/jpeg;base64,") ||
          data.previewDataUri.length > 360000) {
        throw new Error("PREVIEW_UNAVAILABLE");
      }
      if (n === previewGeneration.current) setPreviewImage(data.previewDataUri);
    } catch {
      if (n === previewGeneration.current) setPreviewError(t("captureMonitor.previewUnavailable"));
    } finally {
      if (n === previewGeneration.current) setPreviewBusy(false);
    }
  };
  const closePreview = () => {
    previewGeneration.current++;
    setPreviewRun(null);
    setPreviewImage(null);
    setPreviewError("");
  };

  const deleteFinished = async () => {
    if (!deletion || !canDelete || deleting) return;
    setDeleting(true);
    setNotice(null);
    setError("");
    try {
      const response = await fetchWithTimeout("/api/test-captures", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...deletion, confirm: true }),
      }, 15_000);
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json() as { deleted: number; hasMoreEligible: boolean };
      setNotice({ count: result.deleted, hasMoreEligible: result.hasMoreEligible });
      setDeletion(null);
      closePreview();
      expanded.current = false;
      await load(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "INTERNAL_ERROR");
    } finally {
      setDeleting(false);
    }
  };

  const stats = snapshot?.summary;
  const metrics = [
    { key: "captureMonitor.gatewayReceived" as const, value: stats?.gatewayReceived ?? 0, icon: Server, tone: "text-brand" },
    { key: "captureMonitor.agentReceived" as const, value: stats?.agentReceived ?? 0, icon: Monitor, tone: "text-info" },
    { key: "captureMonitor.rendered" as const, value: stats?.rendered ?? 0, icon: CheckCircle2, tone: "text-ok" },
    { key: "captureMonitor.waiting" as const, value: stats?.waiting ?? 0, icon: Clock3, tone: "text-warn" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-surface px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2 text-xs font-medium text-ink-2">
          <ShieldCheck className="h-4 w-4 text-brand" aria-hidden />
          {t("captureMonitor.simulation")}
        </div>
        <span className="text-xs text-ink-3">{t("captureMonitor.autoRefresh")}</span>
      </div>

      {snapshot && !snapshot.gatewayCaptureEnabled && (
        <div role="status" className="rounded-xl border border-warn-edge bg-warn-bg px-4 py-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-warn">{t("captureMonitor.featureDisabledTitle")}</p>
              <p className="text-sm leading-6 text-ink-2">{t("captureMonitor.featureDisabledBody")}</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={t("captureMonitor.title")}>
        {metrics.map(({ key, value, icon: Icon, tone }) => (
          <div key={key} className="min-w-0 rounded-2xl border border-edge bg-surface p-4 shadow-xs sm:p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold leading-5 text-ink-3">{t(key)}</span>
              <span className={"inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 " + tone}>
                <Icon aria-hidden className="h-4 w-4" />
              </span>
            </div>
            <div className="text-3xl font-bold tracking-tight text-ink tabular-nums">
              {snapshot ? formatNumber(value) : "—"}
            </div>
          </div>
        ))}
      </div>

      <section className="rounded-2xl border border-edge bg-surface shadow-card" aria-label={t("captureMonitor.recentTests")}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-4 py-5 sm:px-6">
          <div className="space-y-1.5">
            <h2 className="text-lg font-bold tracking-tight text-ink">{t("captureMonitor.recentTests")}</h2>
            <p className="text-xs text-ink-3">{snapshot ? t("captureMonitor.totalShown", {
              shown: formatNumber(rows.length), total: formatNumber(stats?.gatewayReceived ?? 0),
            }) : t("captureMonitor.loading")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => {
              expanded.current = false;
              void load(false);
            }} loading={loading} icon={<RefreshCw className="h-4 w-4" aria-hidden />}>
              {loading ? t("captureMonitor.refreshing") : t("captureMonitor.refresh")}
            </Button>
            {canDelete && (
              <Button variant="secondary" size="sm" icon={<Trash2 className="h-4 w-4" aria-hidden />}
                disabled={deleting || loading || !stats?.gatewayReceived}
                onClick={() => setDeletion({ scope: "finished" })}>
                {t("captureMonitor.cleanup")}
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-3 border-b border-edge-subtle bg-surface-2/40 px-4 py-4 sm:px-6">
          <label className="min-w-[160px] flex-1 space-y-1.5 sm:max-w-[280px]">
            <span className="text-xs font-medium text-ink-3">{t("captureMonitor.filterAgent")}</span>
            <span className="relative block">
              <select value={agentFilter} onChange={event => setAgentFilter(event.target.value)}
                className="h-10 w-full appearance-none rounded-lg border border-edge bg-surface ps-3 pe-9 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand">
                <option value="all">{t("captureMonitor.allAgents")}</option>
                {snapshot?.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <ChevronDown aria-hidden className="pointer-events-none absolute end-3 top-3 h-4 w-4 text-ink-3" />
            </span>
          </label>
          <label className="min-w-[160px] flex-1 space-y-1.5 sm:max-w-[230px]">
            <span className="text-xs font-medium text-ink-3">{t("captureMonitor.filterStatus")}</span>
            <span className="relative block">
              <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as CaptureState | "all")}
                className="h-10 w-full appearance-none rounded-lg border border-edge bg-surface ps-3 pe-9 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand">
                <option value="all">{t("captureMonitor.allStatuses")}</option>
                {states.map(state => <option key={state} value={state}>{t(statesUI[state].label)}</option>)}
              </select>
              <ChevronDown aria-hidden className="pointer-events-none absolute end-3 top-3 h-4 w-4 text-ink-3" />
            </span>
          </label>
        </div>

        {notice && (
          <div role="status" className="mx-4 mt-4 rounded-lg border border-ok-edge bg-ok-bg px-4 py-3 text-sm text-ok sm:mx-6">
            {t("captureMonitor.deleteSuccess", { count: formatNumber(notice.count) })}
            {notice.hasMoreEligible && <span className="ms-2">{t("captureMonitor.moreToClear")}</span>}
          </div>
        )}
        {error && (
          <div role="alert" className="mx-4 mt-4 rounded-lg border border-bad-edge bg-bad-bg px-4 py-3 text-sm text-bad sm:mx-6">
            {error === "CAPTURE_ACTIVE" ? t("captureMonitor.deleteNotAllowed") :
              error === "FORBIDDEN" ? t("captureMonitor.restricted") : t("captureMonitor.error")}
            <span className="sr-only">{error}</span>
          </div>
        )}

        {loading && !snapshot ? (
          <div role="status" className="flex min-h-[260px] items-center justify-center gap-2 text-sm text-ink-3">
            <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden />
            {t("captureMonitor.loading")}
          </div>
        ) : error && !snapshot ? (
          <div className="px-5 py-12 text-center" role="alert">
            <p className="mb-4 text-sm text-bad">{t("captureMonitor.errorTitle")}</p>
            <Button size="sm" variant="secondary" onClick={() => void load(false)}>{t("captureMonitor.retry")}</Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex min-h-[245px] flex-col items-center justify-center gap-3 px-5 py-10 text-center">
            <ClipboardCheck className="h-9 w-9 text-ink-4" aria-hidden />
            <h3 className="text-base font-semibold text-ink">{t("captureMonitor.noTestsTitle")}</h3>
            <p className="max-w-md text-sm leading-6 text-ink-3">{t("captureMonitor.noTestsBody")}</p>
            {error && <Button size="sm" variant="secondary" onClick={() => void load(false)}>{t("captureMonitor.retry")}</Button>}
          </div>
        ) : visible.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-ink-3">{t("captureMonitor.noFilteredTests")}</div>
        ) : (
          <div role="list" className="space-y-3 p-4 sm:p-6">
            {visible.map(run => (
              <article role="listitem" key={run.runId}
                className="min-w-0 rounded-xl border border-edge bg-surface px-4 py-4 transition-colors hover:border-edge-strong hover:bg-surface-2/30 sm:px-5">
                <div className="flex min-w-0 flex-wrap items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-edge bg-surface-2 text-brand">
                    {run.status === "rendered_locally"
                      ? <FileCheck2 className="h-5 w-5" aria-hidden /> : <FileClock className="h-5 w-5" aria-hidden />}
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-ink sm:text-base">
                        {run.paperMm === 58 || run.paperMm === 80
                          ? t("captureMonitor.receipt", { width: run.paperMm })
                          : t("captureMonitor.document")}
                      </h3>
                      <StatusBadge tone={statesUI[run.status].tone} label={t(statesUI[run.status].label)} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                      <span>{t("captureMonitor.agentLabel")}: <strong className="text-ink-2">{run.agentName ?? run.agentId}</strong></span>
                      <time dateTime={run.createdAt}>{formatDateTime(run.createdAt)}</time>
                      <span dir="ltr" className="rounded bg-surface-2 px-2 py-0.5 font-mono text-2xs">{run.runId.slice(-8)}</span>
                      {run.pages !== null && <span>{t("captureMonitor.pages")}: {formatNumber(run.pages)}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {canPreview && run.status === "rendered_locally" && run.previewAvailable && (
                      <Button variant="secondary" size="sm" icon={<Eye className="h-4 w-4" aria-hidden />}
                        onClick={() => void openPreview(run)}>{t("captureMonitor.preview")}</Button>
                    )}
                    {canDelete && isFinished(run) && (
                      <Button variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" aria-hidden />}
                        onClick={() => setDeletion({ scope: "one", runId: run.runId })}>{t("captureMonitor.deleteOne")}</Button>
                    )}
                  </div>
                </div>
                <div className="mt-4 grid gap-2 border-t border-edge-subtle pt-4 sm:grid-cols-3">
                  <Stage icon={Server} label={t("captureMonitor.gatewayStage")} detail={t("captureMonitor.gatewayReceived")}
                    done />
                  <Stage icon={Monitor} label={t("captureMonitor.agentStage")}
                    detail={run.agentReceived ? t("captureMonitor.agentReceived") : t("captureMonitor.stageWaiting")}
                    done={run.agentReceived} />
                  <Stage icon={FileText} label={t("captureMonitor.renderStage")}
                    detail={run.status === "rendered_locally" ? t("captureMonitor.stageDone")
                      : run.status === "failed" ? t("captureMonitor.failed")
                        : run.status === "expired" ? t("captureMonitor.expired") : t("captureMonitor.stageWaiting")}
                    done={run.status === "rendered_locally"}
                    failed={run.status === "failed"} />
                </div>
                {!!run.errorCode && (
                  <p dir="ltr" className="mt-3 break-words text-xs text-bad">
                    {t("captureMonitor.failedCode")}: {run.errorCode}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}

        {cursor && (
          <div className="flex justify-center border-t border-edge-subtle p-4">
            <Button variant="secondary" size="sm" loading={paging} disabled={paging}
              onClick={() => { expanded.current = true; void load(true, cursor); }}>
              {paging ? t("captureMonitor.loadingMore") : t("captureMonitor.loadMore")}
            </Button>
          </div>
        )}
      </section>

      <Dialog.Root open={previewRun !== null} onOpenChange={open => { if (!open) closePreview(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-[3px]" />
          <Dialog.Content aria-describedby="capture-monitor-preview-description"
            className="fixed inset-3 z-[101] mx-auto flex w-[calc(100vw-1.5rem)] max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl outline-none sm:inset-6 sm:w-[calc(100vw-3rem)]"
            style={{ maxHeight: "calc(100dvh - 1.5rem)" }}>
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-edge px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <Dialog.Title className="text-base font-bold text-ink">{t("captureMonitor.previewTitle")}</Dialog.Title>
                <Dialog.Description id="capture-monitor-preview-description" className="mt-1 text-xs leading-5 text-ink-3">
                  {t("captureMonitor.previewDescription")}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button aria-label={t("captureMonitor.close")} type="button"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-edge text-ink-2 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand">
                  <X className="h-5 w-5" aria-hidden />
                </button>
              </Dialog.Close>
            </header>
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
              <div className="min-h-0 min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge bg-surface-2 px-3 py-2 sm:px-5">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-3">
                    <ShieldCheck className="h-4 w-4" aria-hidden />{t("captureMonitor.simulation")}
                  </span>
                  <div className="flex items-center gap-1" role="group" aria-label={t("captureMonitor.previewTitle")}>
                    <button type="button" aria-label={t("captureMonitor.zoomOut")}
                      disabled={zoom === 60} onClick={() => setZoom(z => z === null ? 80 : Math.max(60, z - 20))}
                      className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-surface focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40">
                      <ZoomOut className="h-4 w-4" aria-hidden />
                    </button>
                    <span className="min-w-12 text-center font-mono text-xs tabular-nums text-ink-2">{zoom === null ? t("captureMonitor.fit") : zoom + "%"}</span>
                    <button type="button" aria-label={t("captureMonitor.zoomIn")}
                      disabled={zoom === 200} onClick={() => setZoom(z => z === null ? 120 : Math.min(200, z + 20))}
                      className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-surface focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40">
                      <ZoomIn className="h-4 w-4" aria-hidden />
                    </button>
                    <Button size="xs" variant="secondary" onClick={() => setZoom(null)}>{t("captureMonitor.fit")}</Button>
                  </div>
                </div>
                <div className="h-full max-h-[54vh] min-h-[170px] overflow-auto overscroll-contain bg-surface-2 p-5 sm:p-8"
                  role="region" tabIndex={0} aria-label={t("captureMonitor.previewTitle")}>
                  {previewBusy ? (
                    <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-ink-3" role="status">
                      <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden />{t("captureMonitor.previewLoading")}
                    </div>
                  ) : previewError ? (
                    <p role="alert" className="text-center text-sm text-bad">{previewError}</p>
                  ) : previewImage ? (
                    <div className="flex min-w-full justify-center">
                      {/* Only a bounded first-page JPEG, never a file:// path or an untrusted HTML document. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img alt={t("captureMonitor.previewTitle")} src={previewImage}
                        className="h-auto shrink-0 self-start bg-white shadow-[0_16px_48px_rgba(0,0,0,.2)]"
                        style={zoom === null
                          ? { width: "100%", maxWidth: previewRun?.paperMm === 58 ? 260 : previewRun?.paperMm === 80 ? 355 : 650 }
                          : { width: ((previewRun?.paperMm === 58 ? 260 : previewRun?.paperMm === 80 ? 355 : 650) * zoom) / 100, maxWidth: "none" }} />
                    </div>
                  ) : null}
                </div>
              </div>
              <aside className="max-h-[160px] shrink-0 overflow-y-auto border-t border-edge p-5 lg:max-h-none lg:w-[250px] lg:border-s lg:border-t-0">
                <h3 className="text-sm font-semibold text-ink">{t("captureMonitor.details")}</h3>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 text-xs lg:grid-cols-1">
                  <DataField label={t("captureMonitor.agentLabel")} value={previewRun?.agentName ?? previewRun?.agentId ?? "—"} />
                  <DataField label={t("captureMonitor.sentAt")} value={previewRun ? formatDateTime(previewRun.createdAt) : "—"} />
                  <DataField label={t("captureMonitor.claimedAt")} value={previewRun?.claimedAt ? formatDateTime(previewRun.claimedAt) : "—"} />
                  <DataField label={t("captureMonitor.pages")} value={previewRun?.pages == null ? "—" : formatNumber(previewRun.pages)} />
                  <DataField label={t("captureMonitor.size")} value={previewRun?.pdfBytes == null ? "—" : formatBytes(previewRun.pdfBytes)} />
                </dl>
                <p className="mt-6 rounded-lg border border-edge bg-surface-2 p-3 text-xs leading-5 text-ink-3">
                  {t("captureMonitor.simulation")}
                </p>
              </aside>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={deletion !== null} onOpenChange={open => { if (!open && !deleting) setDeletion(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[110] bg-black/65" />
          <Dialog.Content aria-describedby="capture-monitor-delete-description"
            className="fixed left-1/2 top-1/2 z-[111] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-edge bg-surface p-6 shadow-2xl outline-none">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-bad-edge bg-bad-bg text-bad">
              <Trash2 className="h-5 w-5" aria-hidden />
            </div>
            <Dialog.Title className="text-lg font-semibold text-ink">{t("captureMonitor.confirmTitle")}</Dialog.Title>
            <Dialog.Description id="capture-monitor-delete-description" className="mt-3 text-sm leading-6 text-ink-2">
              {deletion?.scope === "one" ? t("captureMonitor.confirmOne") : t("captureMonitor.confirmAll")}
            </Dialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" disabled={deleting} onClick={() => setDeletion(null)}>
                {t("captureMonitor.cancel")}
              </Button>
              <Button variant="danger" loading={deleting} onClick={() => void deleteFinished()}>
                {t("captureMonitor.confirm")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function DataField({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 space-y-1">
    <dt className="text-ink-3">{label}</dt>
    <dd className="break-words font-medium text-ink">{value}</dd>
  </div>;
}

function Stage({
  icon: Icon, label, detail, done, failed = false,
}: {
  icon: typeof Server; label: string; detail: string; done: boolean; failed?: boolean;
}) {
  return (
    <div className={"flex min-w-0 items-center gap-2 rounded-lg px-3 py-2.5 " +
      (done ? "bg-ok-bg/40" : failed ? "bg-bad-bg/40" : "bg-surface-2/70")}>
      <div className={"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg " +
        (done ? "bg-ok-bg text-ok" : failed ? "bg-bad-bg text-bad" : "bg-surface text-ink-3")}>
        {done ? <CheckCircle2 className="h-4 w-4" aria-hidden />
          : failed ? <AlertCircle className="h-4 w-4" aria-hidden />
            : <Icon className="h-4 w-4" aria-hidden />}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-ink">{label}</p>
        <p className="text-2xs text-ink-3">{detail}</p>
      </div>
    </div>
  );
}
