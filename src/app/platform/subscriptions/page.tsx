"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, Card, ErrorState, LoadingState, PageHeader } from "../../../components/ui";
import { AdminStatus, adminJson, controlClass } from "../../../components/platform/ManualAdmin";
import { useI18n } from "../../../i18n/react";
import type { MessageKey } from "../../../i18n/messages/en";
import { useCallback } from "react";
import { formatManualCalendarDate } from "../../../lib/manual-calendar-date";

type Subscription = {
  tenantId: string;
  tenantName: string;
  planName: string;
  status: string;
  subscriptionType: string;
  monthlyQuota: number | null;
  used: number;
  currentPeriodEnd: string | null;
  term: string;
};

const PAGE_SIZE = 50;

export default function Subscriptions() {
  const { t, locale, formatNumber } = useI18n();
  // Contract dates use UTC calendar days, exactly as the previous helper did.
  const formatDate = useCallback((value: Date | string | number | null | undefined) => formatManualCalendarDate(value, locale) ?? t("common.notAvailable"), [locale, t]);
  const [items, setItems] = useState<Subscription[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const query = new URLSearchParams({ search, status: status, limit: String(PAGE_SIZE), offset: String(offset) });
    adminJson("/api/platform/subscriptions?" + query.toString(), { signal: controller.signal })
      .then((data: { subscriptions: Subscription[]; hasMore: boolean }) => {
        if (live) { setItems(data.subscriptions); setHasMore(data.hasMore); setError(false); }
      })
      .catch(() => { if (live) { setItems([]); setHasMore(false); setError(true); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [search, status, offset, tick]);

  const visible = items;
  return <div className="space-y-5">
    <PageHeader variant="inline" title={t("v4.admin.subscriptions")} actions={
      <div className="flex flex-wrap gap-2">
        <Link className="rounded-lg border border-edge px-4 py-2 text-sm transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35" href="/platform/plans">{t("v4.admin.editPlan")}</Link>
        <Button disabled={loading} loading={loading} onClick={() => { setLoading(true); setError(false); setTick(n => n + 1); }}>{t("v4.admin.refresh")}</Button>
      </div>} />
    <div className="grid gap-3 sm:grid-cols-2">
      <input className={controlClass} aria-label={t("v4.admin.search")} placeholder={t("v4.admin.search")} value={search}
        onChange={event => { setOffset(0); setHasMore(false); setLoading(true); setError(false); setSearch(event.target.value); }} />
      <select className={controlClass} aria-label={t("v4.admin.status")} value={status}
        onChange={event => { setOffset(0); setHasMore(false); setLoading(true); setError(false); setStatus(event.target.value); }}>
        {["all", "active", "awaiting_activation", "expired", "suspended"].map(value =>
          <option key={value} value={value}>{t(`v4.admin.${value}` as MessageKey)}</option>)}
      </select>
    </div>
    {error && <ErrorState title={t("v4.admin.subscriptions")} message={t("v4.admin.loadError")} retry={() => { setLoading(true); setError(false); setTick(n => n + 1); }} />}
    {loading ? <div role="status" aria-busy="true" aria-label={t("v4.admin.loading")}><LoadingState rows={4} /></div> : !error && visible.length === 0
      ? <p className="rounded-xl border border-edge p-5 text-sm text-ink-3">{t("v4.admin.empty")}</p>
      : <div className="grid gap-4 lg:grid-cols-2">
        {visible.map(item => <Card key={item.tenantId} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="break-words text-lg font-medium">{item.tenantName}</h2>
              <p className="mt-1 text-sm text-ink-3">
                <bdi dir="auto">{item.planName}</bdi> · {t(`v4.admin.${item.term}` as MessageKey)} · {t(`v4.admin.${item.subscriptionType}` as MessageKey)}
              </p>
            </div>
            <AdminStatus status={item.status} />
          </div>
          <dl className="my-5 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-ink-3">{t("v4.admin.usedOfQuota")}</dt>
              <dd className="mt-1 font-semibold tabular-nums">
                <bdi dir="ltr">{formatNumber(item.used)} / {item.monthlyQuota === null ? t("v4.admin.unlimited") : formatNumber(item.monthlyQuota)}</bdi>
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">{t("v4.admin.end")}</dt>
              <dd className="mt-1 font-semibold tabular-nums">
                {item.currentPeriodEnd ? <bdi dir="ltr">{formatDate(item.currentPeriodEnd)}</bdi> : t("v4.admin.notRecorded")}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-4 border-t border-edge-subtle pt-4">
            <Link className="rounded-sm text-sm font-semibold text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              href={"/platform/tenants/" + encodeURIComponent(item.tenantId) + "?tab=subscriptions"}>
              {t("v4.admin.manage")}
            </Link>
            {item.status === "active" && <Link
              className="rounded-sm text-sm font-medium text-bad underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              href={"/platform/tenants/" + encodeURIComponent(item.tenantId) + "?subscriptionAction=revoke"}>
              {t("v4.admin.endSubscriptionNow")}
            </Link>}
          </div>
        </Card>)}
      </div>}
    {!loading && !error && (items.length > 0 || offset > 0) && <nav aria-label={t("v4.admin.subscriptions")} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge p-3">
      <Button type="button" variant="secondary" size="sm" disabled={offset === 0}
        onClick={() => { setLoading(true); setOffset(value => Math.max(0, value - PAGE_SIZE)); }}>
        {t("common.previousPage")}
      </Button>
      <span aria-live="polite" className="text-sm tabular-nums text-ink-3">
        {t("common.pageRange", { start: formatNumber(items.length ? offset + 1 : 0), end: formatNumber(offset + items.length) })}
      </span>
      <Button type="button" variant="secondary" size="sm" disabled={!hasMore}
        onClick={() => { setLoading(true); setOffset(value => value + PAGE_SIZE); }}>
        {t("common.nextPage")}
      </Button>
    </nav>}
  </div>;
}
