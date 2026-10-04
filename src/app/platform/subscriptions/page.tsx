"use client";

import { useEffect, useMemo, useState } from "react";
import { CreditCard, Search, RefreshCw, Inbox } from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  PageHeader,
  EmptyState,
  ErrorState,
  Input,
  SegmentedControl,
  StatusBadge,
  TableSkeleton,
  type Tone,
} from "../../../components/ui";
import { useI18n } from "../../../i18n/react";
import type { MessageKey } from "../../../i18n/messages/en";

type SubscriptionStatus = "trialing" | "active" | "past_due" | "paused" | "cancelled" | "incomplete" | "incomplete_expired" | "unpaid";

type Subscription = {
  tenantId: string;
  tenantName: string;
  tenantLifecycle: string;
  planId: string;
  planName: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  trialStartedAt: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
};

const STATUS_META: Record<SubscriptionStatus, { tone: Tone; key: MessageKey }> = {
  active: { tone: "ok", key: "platform.subs.status.active" },
  trialing: { tone: "brand", key: "platform.subs.status.trialing" },
  past_due: { tone: "bad", key: "platform.subs.status.past_due" },
  paused: { tone: "warn", key: "platform.subs.status.paused" },
  incomplete: { tone: "warn", key: "platform.subs.status.incomplete" },
  incomplete_expired: { tone: "neutral", key: "platform.subs.status.incomplete_expired" },
  unpaid: { tone: "bad", key: "platform.subs.status.unpaid" },
  cancelled: { tone: "neutral", key: "platform.subs.status.cancelled" },
};

function statusMeta(status: string): { tone: Tone; key: MessageKey | null; raw: string } {
  const meta = STATUS_META[status as SubscriptionStatus];
  return meta ? { tone: meta.tone, key: meta.key, raw: status } : { tone: "neutral", key: null, raw: status };
}

type Filter = "all" | "active" | "attention" | "other";

export default function PlatformSubscriptionsPage() {
  const { t, locale, formatNumber, formatDate } = useI18n();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [completedQuery, setCompletedQuery] = useState<string | null>(null);
  const [search, setSearchValue] = useState("");
  const [filter, setFilterValue] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const queryKey = JSON.stringify([offset, search, filter, reloadKey, locale]);
  const loading = completedQuery !== queryKey;
  function setSearch(value: string) { setSearchValue(value); setOffset(0); }
  function setFilter(value: Filter) { setFilterValue(value); setOffset(0); }


  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch(`/api/platform/subscriptions?limit=100&offset=${offset}&search=${encodeURIComponent(search.trim())}&filter=${filter}`);
        if (ignore) return;
        if (!res.ok) throw new Error(t("platform.subs.loadFailed"));
        const data = await res.json();
        if (!ignore) { setSubscriptions(data.subscriptions || []); setHasMore(data.hasMore === true); setError(null); }
      } catch {
        if (!ignore) setError(t("platform.subs.loadError"));
      } finally { if (!ignore) setCompletedQuery(queryKey); }
    }
    load();
    return () => { ignore = true; };
  }, [reloadKey, t, offset, search, filter, queryKey]);

  function handleRefresh() { setReloadKey((k) => k + 1); }

  const counts = useMemo(
    () => ({
      all: subscriptions.length,
      active: subscriptions.filter((s) => s.status === "active" || s.status === "trialing").length,
      attention: subscriptions.filter((s) => ["past_due", "paused", "incomplete", "unpaid"].includes(s.status)).length,
      other: subscriptions.filter((s) => ["cancelled", "incomplete_expired"].includes(s.status)).length,
    }),
    [subscriptions],
  );

  const filtered = subscriptions.filter((s) => {
    const term = search.trim().toLowerCase();
    const matchesSearch =
      term.length === 0 ||
      s.tenantName.toLowerCase().includes(term) ||
      s.tenantId.toLowerCase().includes(term) ||
      (s.stripeCustomerId ? s.stripeCustomerId.toLowerCase().includes(term) : false);
    const matchesFilter =
      filter === "all"
        ? true
        : filter === "active"
          ? s.status === "active" || s.status === "trialing"
          : filter === "attention"
            ? ["past_due", "paused", "incomplete", "unpaid"].includes(s.status)
            : ["cancelled", "incomplete_expired"].includes(s.status);
    return matchesSearch && matchesFilter;
  });

  return (
    <div className="space-y-5">
      <PageHeader
        variant="inline"
        icon={<CreditCard className="h-4 w-4" aria-hidden />}
        title={t("platform.subs.title")}
        description={t("platform.subs.description")}
        actions={
          <>
            {counts.attention > 0 && (
              <StatusBadge tone="bad" label={t("platform.subs.needAttention", { count: formatNumber(counts.attention) })} />
            )}
            <Button
              variant="secondary"
              onClick={handleRefresh}
              disabled={loading}
              loading={loading}
              icon={loading ? undefined : <RefreshCw className="h-4 w-4" aria-hidden />}
            >
              {loading ? t("platform.subs.refreshing") : t("platform.subs.refresh")}
            </Button>
          </>
        }
      />

      {error && (
        <ErrorState
          title={t("platform.subs.unavailable")}
          message={error}
          retry={handleRefresh}
        />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title={t("platform.subs.all")}
          subtitle={t("platform.subs.shown", { filtered: formatNumber(filtered.length), total: formatNumber(subscriptions.length) })}
          actions={
            <SegmentedControl
              label={t("platform.subs.filterLabel")}
              value={filter}
              onChange={setFilter}
              size="sm"
              options={[
                { value: "all", label: t("platform.subs.filter.all", { count: formatNumber(counts.all) }) },
                { value: "active", label: t("platform.subs.filter.active", { count: formatNumber(counts.active) }) },
                { value: "attention", label: t("platform.subs.filter.attention", { count: formatNumber(counts.attention) }) },
                { value: "other", label: t("platform.subs.filter.other", { count: formatNumber(counts.other) }) },
              ]}
            />
          }
        />

        <div className="border-b border-edge-subtle px-5 py-3">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("platform.subs.searchPlaceholder")}
              aria-label={t("platform.subs.searchLabel")}
              className="ps-9"
            />
          </div>
        </div>

        {loading && subscriptions.length === 0 ? (
          <TableSkeleton rows={6} columns={5} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-5 w-5" />}
            title={subscriptions.length === 0 ? t("platform.subs.emptyTitle") : t("platform.subs.noMatchesTitle")}
            description={
              subscriptions.length === 0
                ? t("platform.subs.emptyBody")
                : t("platform.subs.noMatchesBody")
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[860px]">
              <caption className="sr-only">{t("platform.subs.tableCaption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("platform.subs.tenant")}</th>
                  <th scope="col">{t("platform.subs.plan")}</th>
                  <th scope="col">{t("platform.subs.billingStatus")}</th>
                  <th scope="col">{t("platform.subs.stripeCustomer")}</th>
                  <th scope="col">{t("platform.subs.periodEnd")}</th>
                  <th scope="col" className="text-end">{t("platform.subs.created")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const meta = statusMeta(s.status);
                  return (
                    <tr key={s.tenantId}>
                      <td>
                        <div className="text-sm font-[550] text-ink">{s.tenantName}</div>
                        <div className="mt-0.5 font-mono text-2xs text-ink-4">{s.tenantId}</div>
                      </td>
                      <td className="text-sm text-ink-2">{s.planName}</td>
                      <td>
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge tone={meta.tone} label={meta.key ? t(meta.key) : meta.raw} size="sm" />
                          {s.cancelAtPeriodEnd && <StatusBadge tone="warn" label={t("platform.subs.cancelsAtPeriodEnd")} size="sm" />}
                        </div>
                      </td>
                      <td className="font-mono text-2xs text-ink-3">{s.stripeCustomerId || t("platform.subs.unlinkedTrial")}</td>
                      <td className="text-sm text-ink-3">
                        {s.currentPeriodEnd ? formatDate(s.currentPeriodEnd) : t("common.notAvailable")}
                      </td>
                      <td className="text-end text-sm text-ink-3">
                        {formatDate(s.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-ink-3">{t("common.pageRange", { start: formatNumber(offset + 1), end: formatNumber(offset + subscriptions.length) })}</span>
        <div className="flex gap-2">
          <Button disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 100))}>{t("common.previousPage")}</Button>
          <Button disabled={loading || !hasMore} onClick={() => setOffset(value => value + 100)}>{t("common.nextPage")}</Button>
        </div>
      </div>
    </div>
  );
}
