"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, ClipboardList } from "lucide-react";
import { Button, Card, ErrorState, LoadingState, PageHeader } from "../../../components/ui";
import { AdminStatus, adminJson, controlClass } from "../../../components/platform/ManualAdmin";
import { useI18n } from "../../../i18n/react";
import type { MessageKey } from "../../../i18n/messages/en";

type RequestRow = {
  id: string;
  tenant_id: string;
  tenantName: string;
  plan_id: string;
  planName: string;
  planMonthlyQuota: number | null;
  currentPlanName: string | null;
  currentSubscriptionStatus: string | null;
  requester_name: string;
  requester_email: string;
  requested_monthly_quota: number | null;
  term: string;
  status: string;
  created_at: string;
  last_action_reason: string | null;
};
type RequestResponse = { requests: RequestRow[]; hasMore: boolean; pendingCount: number };

export default function Requests() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const [items, setItems] = useState<RequestRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [status, setStatus] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    adminJson(`/api/platform/subscription-requests?status=${encodeURIComponent(status)}&offset=${offset}`, { signal: controller.signal })
      .then((result: RequestResponse) => {
        if (!live) return;
        setItems(result.requests);
        setHasMore(result.hasMore === true);
        setPendingCount(result.pendingCount);
        setError(false);
      })
      .catch(() => {
        if (live) { setError(true); setItems([]); setHasMore(false); setPendingCount(0); }
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [status, tick, offset]);

  return <div className="space-y-5">
    <PageHeader variant="inline" title={t("v4.admin.requests")} actions={<Button disabled={loading} loading={loading} onClick={() => { setLoading(true); setError(false); setTick(x => x + 1); }}>{t("v4.admin.refresh")}</Button>} />
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-surface p-4">
      <div className="flex items-center gap-3">
        <span className="rounded-lg bg-brand/10 p-2.5 text-brand"><ClipboardList className="h-5 w-5" aria-hidden /></span>
        <div>
          <p className="text-sm text-ink-3">{t("v4.admin.pendingRequests")}</p>
          <p className="text-2xl font-semibold tabular-nums" aria-live="polite">{formatNumber(pendingCount)}</p>
        </div>
      </div>
      <label className="w-full text-sm sm:w-52">
        <span className="sr-only">{t("v4.admin.status")}</span>
        <select className={controlClass} aria-label={t("v4.admin.status")} value={status}
          onChange={e => { setLoading(true); setStatus(e.target.value); setOffset(0); }}>
          {["pending", "approved", "rejected", "all"].map(item => <option key={item} value={item}>{t(`v4.admin.${item}` as MessageKey)}</option>)}
        </select>
      </label>
    </div>
    {error && <ErrorState title={t("v4.admin.requests")} message={t("v4.admin.loadError")} retry={() => { setLoading(true); setError(false); setTick(x => x + 1); }} />}
    {loading ? <div role="status" aria-busy="true" aria-label={t("v4.admin.loading")}><LoadingState rows={4} /></div> : !error && !items.length
      ? <p className="rounded-xl border border-edge bg-surface p-6 text-sm text-ink-3">{t("v4.admin.empty")}</p>
      : <div className="grid gap-4">
          {items.map(request => {
            const quota = request.requested_monthly_quota ?? request.planMonthlyQuota;
            return <Card key={request.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-medium">{request.tenantName}</h2>
                  <p className="mt-1 break-all font-mono text-xs text-ink-3" dir="ltr">{request.id}</p>
                </div>
                <AdminStatus status={request.status} />
              </div>
              <dl className="mt-5 grid gap-4 rounded-lg bg-surface-2 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-ink-3">{t("v4.admin.requestedPlan")}</dt><dd className="mt-1 font-semibold">{request.planName}</dd></div>
                <div><dt className="text-ink-3">{t("v4.admin.term")}</dt><dd className="mt-1 font-semibold">{t(`v4.admin.${request.term}` as MessageKey)}</dd></div>
                <div><dt className="text-ink-3">{t("v4.admin.quota")}</dt><dd className="mt-1 font-semibold tabular-nums">{quota === null ? t("v4.admin.notRecorded") : formatNumber(quota)}</dd></div>
                <div><dt className="text-ink-3">{t("v4.admin.created")}</dt><dd className="mt-1 font-semibold tabular-nums">{formatDateTime(request.created_at)}</dd></div>
              </dl>
              <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0 text-sm">
                  <p className="text-ink-3">{t("v4.admin.requester")}</p>
                  <p className="font-medium">{request.requester_name || t("v4.admin.notRecorded")}</p>
                  <p className="break-all text-ink-2" dir="ltr">{request.requester_email}</p>
                  {request.currentPlanName && <p className="mt-2 text-ink-3">{t("v4.admin.currentSubscription")}: {request.currentPlanName}</p>}
                  {request.last_action_reason && <p className="mt-2 text-ink-3">{request.last_action_reason}</p>}
                </div>
                <Link className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand-solid px-4 py-2 text-sm font-semibold text-brand-contrast hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  href={`/platform/tenants/${encodeURIComponent(request.tenant_id)}?request=${encodeURIComponent(request.id)}`}>
                  {request.status === "pending" ? t("v4.admin.review") : t("v4.admin.open")} <ArrowUpRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
                </Link>
              </div>
            </Card>;
          })}
        </div>}
    {!error && !loading && (offset > 0 || hasMore) && <nav className="flex justify-end gap-3" aria-label={t("v4.admin.requests")}>
      <Button disabled={offset === 0} onClick={() => { setLoading(true); setOffset(x => Math.max(0, x - 100)); }}>{t("common.previousPage")}</Button>
      <Button disabled={!hasMore} onClick={() => { setLoading(true); setOffset(x => x + 100); }}>{t("common.nextPage")}</Button>
    </nav>}
  </div>;
}
