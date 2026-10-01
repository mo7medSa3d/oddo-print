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

type SubscriptionStatus = "trialing" | "active" | "past_due" | "paused" | "cancelled";

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

const STATUS_META: Record<SubscriptionStatus, { tone: Tone; label: string }> = {
  active: { tone: "ok", label: "Active" },
  trialing: { tone: "brand", label: "Trialing" },
  past_due: { tone: "bad", label: "Past due" },
  paused: { tone: "warn", label: "Paused" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

function statusMeta(status: string): { tone: Tone; label: string } {
  return STATUS_META[status as SubscriptionStatus] ?? { tone: "neutral", label: status };
}

type Filter = "all" | "active" | "attention" | "other";

export default function PlatformSubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/platform/subscriptions");
        if (ignore) return;
        if (!res.ok) throw new Error("Failed to fetch platform subscriptions");
        const data = await res.json();
        if (!ignore) { setSubscriptions(data.subscriptions || []); setError(null); }
      } catch (err: unknown) {
        if (!ignore) setError(err instanceof Error ? err.message : "Error loading subscriptions");
      } finally { if (!ignore) setLoading(false); }
    }
    load();
    return () => { ignore = true; };
  }, [reloadKey]);

  function handleRefresh() { setLoading(true); setReloadKey((k) => k + 1); }

  const counts = useMemo(
    () => ({
      all: subscriptions.length,
      active: subscriptions.filter((s) => s.status === "active" || s.status === "trialing").length,
      attention: subscriptions.filter((s) => s.status === "past_due" || s.status === "paused").length,
      other: subscriptions.filter((s) => s.status === "cancelled").length,
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
            ? s.status === "past_due" || s.status === "paused"
            : s.status === "cancelled";
    return matchesSearch && matchesFilter;
  });

  return (
    <div className="space-y-5">
      <PageHeader
        variant="inline"
        eyebrow="Control plane · Billing"
        icon={<CreditCard className="h-4 w-4" aria-hidden />}
        title="Subscriptions"
        description="Stripe lifecycle state for every tenant on this Gateway."
        actions={
          <>
            {counts.attention > 0 && (
              <StatusBadge tone="bad" label={`${counts.attention} need attention`} />
            )}
            <Button
              variant="secondary"
              onClick={handleRefresh}
              disabled={loading}
              loading={loading}
              icon={loading ? undefined : <RefreshCw className="h-4 w-4" aria-hidden />}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </>
        }
      />

      {error && (
        <ErrorState
          title="Subscriptions unavailable"
          message={error}
          retry={handleRefresh}
        />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title="All subscriptions"
          subtitle={`${filtered.length} of ${subscriptions.length} shown`}
          actions={
            <SegmentedControl
              label="Filter by subscription status"
              value={filter}
              onChange={setFilter}
              size="sm"
              options={[
                { value: "all", label: `All (${counts.all})` },
                { value: "active", label: `Active (${counts.active})` },
                { value: "attention", label: `Attention (${counts.attention})` },
                { value: "other", label: `Cancelled (${counts.other})` },
              ]}
            />
          }
        />

        <div className="border-b border-edge-subtle px-5 py-3">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by tenant name, ID or Stripe customer…"
              aria-label="Filter subscriptions"
              className="pl-9"
            />
          </div>
        </div>

        {loading && subscriptions.length === 0 ? (
          <TableSkeleton rows={6} columns={5} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-5 w-5" />}
            title={subscriptions.length === 0 ? "No subscriptions yet" : "No matching subscriptions"}
            description={
              subscriptions.length === 0
                ? "Subscriptions appear here as soon as a tenant completes Stripe checkout."
                : "Adjust the search term or switch the status filter to see more results."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[860px]">
              <caption className="sr-only">Platform subscriptions</caption>
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Plan</th>
                  <th scope="col">Billing status</th>
                  <th scope="col">Stripe customer</th>
                  <th scope="col">Period end</th>
                  <th scope="col" className="text-right">Created</th>
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
                          <StatusBadge tone={meta.tone} label={meta.label} size="sm" />
                          {s.cancelAtPeriodEnd && <StatusBadge tone="warn" label="Cancels at period end" size="sm" />}
                        </div>
                      </td>
                      <td className="font-mono text-2xs text-ink-3">{s.stripeCustomerId || "Unlinked (trial)"}</td>
                      <td className="text-sm text-ink-3">
                        {s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : "—"}
                      </td>
                      <td className="text-right text-sm text-ink-3">
                        {new Date(s.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
