"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  Building2,
  CreditCard,
  RefreshCw,
  ShieldCheck,
  Users,
  ArrowRight,
} from "lucide-react";
import {
  FleetHealthChart,
  OperationalSignals,
  PrintThroughputChart,
  SubscriptionMixChart,
  type OverviewHourlyPoint,
} from "../../../components/platform/overview-charts";
import {
  Button,
  Callout,
  Card,
  CardHeader,
  PageHeader,
  EmptyState,
  ErrorState,
  PageSkeleton,
  StatusBadge,
  type Tone,
} from "../../../components/ui";
import { useI18n } from "../../../i18n/react";
import type { MessageKey } from "../../../i18n/messages/en";

type Stats = {
  tenants: { total: number; active: number; suspended: number; deleted: number };
  subscriptions: {
    total: number;
    active: number;
    trialing: number;
    pastDue: number;
    incomplete: number;
    incompleteExpired: number;
    unpaid: number;
    paused: number;
    cancelled: number;
    attention: number;
  };
  users: { total: number; verified: number };
  agents: { total: number; online: number; offline: number };
  printers: { total: number; online: number; offline: number };
  jobs24h: { total: number; success: number; failed: number; queued: number; inFlight: number; expired: number };
  jobs24hHourly: OverviewHourlyPoint[];
};

type TenantRow = {
  id: string;
  name: string;
  lifecycle: "active" | "suspended" | "deleted";
  createdAt: string;
};

type SubscriptionRow = {
  tenantId: string;
  tenantName: string;
  planName: string;
  stripeSubscriptionId: string | null;
  status:
    | "trialing"
    | "active"
    | "past_due"
    | "incomplete"
    | "incomplete_expired"
    | "unpaid"
    | "paused"
    | "cancelled";
  createdAt: string;
};

function percent(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : null;
}

const SUBSCRIPTION_META: Record<SubscriptionRow["status"], { tone: Tone; key: MessageKey }> = {
  active: { tone: "ok", key: "platform.dashboard.sub.active" },
  trialing: { tone: "info", key: "platform.dashboard.sub.trialing" },
  past_due: { tone: "warn", key: "platform.dashboard.sub.past_due" },
  incomplete: { tone: "warn", key: "platform.dashboard.sub.incomplete" },
  incomplete_expired: { tone: "warn", key: "platform.dashboard.sub.incomplete_expired" },
  unpaid: { tone: "bad", key: "platform.dashboard.sub.unpaid" },
  paused: { tone: "neutral", key: "platform.dashboard.sub.paused" },
  cancelled: { tone: "bad", key: "platform.dashboard.sub.cancelled" },
};

const LIFECYCLE_META: Record<TenantRow["lifecycle"], { tone: Tone; key: MessageKey }> = {
  active: { tone: "ok", key: "platform.dashboard.lifecycle.active" },
  suspended: { tone: "warn", key: "platform.dashboard.lifecycle.suspended" },
  deleted: { tone: "bad", key: "platform.dashboard.lifecycle.deleted" },
};

export default function PlatformDashboardPage() {
  const router = useRouter();
  const { t, formatNumber, formatDate } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partialError, setPartialError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Single-observation snapshot age: the badge states when the numbers were
  // read instead of claiming a live feed (C061).
  const [statsFetchedAt, setStatsFetchedAt] = useState("—");

  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const [statsRes, tenantsRes, subsRes] = await Promise.all([
          fetch("/api/platform/stats", { cache: "no-store" }),
          fetch("/api/platform/tenants?limit=10", { cache: "no-store" }),
          fetch("/api/platform/subscriptions?limit=10", { cache: "no-store" }),
        ]);

        if (ignore) return;

        if (!statsRes.ok) {
          if (statsRes.status === 401 || statsRes.status === 403) {
            router.push("/platform/login");
            return;
          }
          throw new Error(t("platform.dashboard.loadFailed"));
        }

        const statsData = (await statsRes.json()) as Stats;
        // Secondary lists degrade independently: a failed tenants/subscriptions
        // fetch must surface as incomplete data, never as a silent empty list
        // that reads "no workspaces" (C061).
        const tenantsFailed = !tenantsRes.ok;
        const subsFailed = !subsRes.ok;
        const tenantsData = tenantsFailed ? { tenants: [] } : await tenantsRes.json();
        const subscriptionsData = subsFailed ? { subscriptions: [] } : await subsRes.json();

        if (!ignore) {
          setStats(statsData);
          setStatsFetchedAt(new Date().toLocaleTimeString());
          setTenants(Array.isArray(tenantsData.tenants) ? tenantsData.tenants : []);
          setSubscriptions(
            Array.isArray(subscriptionsData.subscriptions) ? subscriptionsData.subscriptions : [],
          );
          setError(null);
          setPartialError(
            tenantsFailed || subsFailed ? t("platform.dashboard.partialData") : null,
          );
        }
      } catch {
        if (!ignore) {
          setError(t("platform.dashboard.loadError"));
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();

    return () => {
      ignore = true;
    };
  }, [router, reloadKey, t]);

  const derived = useMemo(() => {
    const terminalJobs =
      (stats?.jobs24h.success ?? 0) +
      (stats?.jobs24h.failed ?? 0) +
      (stats?.jobs24h.expired ?? 0);
    const hourly = stats?.jobs24hHourly ?? [];
    const latest = hourly.at(-1);
    const previous = hourly.at(-2);
    const latestDelta =
      latest && previous && previous.total > 0
        ? Math.round(((latest.total - previous.total) / previous.total) * 100)
        : null;

    return {
      jobSuccessRate: percent(stats?.jobs24h.success ?? 0, terminalJobs),
      latestHour: latest?.total ?? 0,
      latestHourDelta: latestDelta,
      hourlyHasData: hourly.some((point) => point.total > 0),
    };
  }, [stats]);
  return (
    <div className="space-y-6">
      <PageHeader
        variant="inline"
        title={t("platform.dashboard.title")}
        description={t("platform.dashboard.description")}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setLoading(true);
                setReloadKey((value) => value + 1);
              }}
              disabled={loading}
              loading={loading}
              icon={loading ? undefined : <RefreshCw className="h-4 w-4" aria-hidden />}
            >
              {loading ? t("platform.dashboard.refreshing") : t("platform.dashboard.refresh")}
            </Button>
            <Button variant="primary" href="/platform/audit" icon={<ShieldCheck className="h-4 w-4" aria-hidden />}>
              {t("platform.dashboard.securityAudit")}
            </Button>
          </>
        }
      />

      {loading && !stats ? (
        <div role="status" aria-label={t("platform.dashboard.loadingAria")}>
          <PageSkeleton />
          <span className="sr-only">{t("platform.dashboard.loadingShort")}</span>
        </div>
      ) : !stats ? (
        <ErrorState title={t("platform.dashboard.statsUnavailable")} message={error ?? t("platform.dashboard.loadError")} retry={() => { setLoading(true); setReloadKey(value => value + 1); }} />
      ) : (
        <>
          {error && (
            <ErrorState
              title={t("platform.dashboard.statsUnavailable")}
              message={error}
              retry={() => {
                setLoading(true);
                setReloadKey((value) => value + 1);
              }}
            />
          )}

          {partialError && (
            <Callout tone="warn" title={t("platform.dashboard.partialDataTitle")}>
              {partialError}
            </Callout>
          )}

          <OperationalSignals
            jobs={{
              failed: stats?.jobs24h.failed ?? 0,
              expired: stats?.jobs24h.expired ?? 0,
              queued: stats?.jobs24h.queued ?? 0,
              inFlight: stats?.jobs24h.inFlight ?? 0,
            }}
            agents={{ offline: stats?.agents.offline ?? 0 }}
            printers={{ offline: stats?.printers.offline ?? 0 }}
            pastDue={stats?.subscriptions.attention ?? stats?.subscriptions.pastDue ?? 0}
          />

          <section className="grid grid-cols-1 gap-5 xl:grid-cols-[1.55fr_0.85fr]">
            <Card className="p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-md font-[600] tracking-[-0.015em] text-ink">
                    <Activity className="h-4 w-4 text-brand" aria-hidden />
                    {t("platform.dashboard.throughput")}
                  </h2>
                  <p className="mt-1 text-sm text-ink-3">
                    {t("platform.dashboard.throughputSubtitle")}
                  </p>
                </div>
                <div className="text-start sm:text-end">
                  <div className="text-3xl font-[660] leading-none tracking-[-0.03em] text-ink tabular">
                    {formatNumber(stats?.jobs24h.total ?? 0)}
                  </div>
                  <div className="mt-1.5 text-xs text-ink-3">
                    {t("platform.dashboard.jobsIn24h")}
                    {derived.jobSuccessRate !== null ? ` ${t("platform.dashboard.successRate", { rate: formatNumber(derived.jobSuccessRate) })}` : ""}
                  </div>
                </div>
              </div>

              {derived.hourlyHasData ? (
                <PrintThroughputChart data={stats?.jobs24hHourly ?? []} />
              ) : (
                <EmptyState
                  className="mt-4 rounded-sg border border-dashed border-edge-strong bg-surface-2"
                  icon={<Activity className="h-5 w-5" />}
                  title={t("platform.dashboard.noActivity")}
                  description={t("platform.dashboard.noActivityBody")}
                />
              )}

              <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-edge-subtle pt-4 text-xs text-ink-3">
                <div className="flex items-center gap-1.5">
                  <dt>{t("platform.dashboard.successful")}</dt>
                  <dd className="font-[600] tabular text-ink">{formatNumber(stats?.jobs24h.success ?? 0)}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt>{t("platform.dashboard.failed")}</dt>
                  <dd className="font-[600] tabular text-ink">{formatNumber(stats?.jobs24h.failed ?? 0)}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt>{t("platform.dashboard.expired")}</dt>
                  <dd className="font-[600] tabular text-ink">{formatNumber(stats?.jobs24h.expired ?? 0)}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt>{t("platform.dashboard.openNow")}</dt>
                  <dd className="font-[600] tabular text-ink">
                    {formatNumber((stats?.jobs24h.queued ?? 0) + (stats?.jobs24h.inFlight ?? 0))}
                  </dd>
                </div>
                {derived.latestHourDelta !== null && (
                  <div className="flex items-center gap-1.5">
                    <dt>{t("platform.dashboard.latestHourDelta")}</dt>
                    <dd className={`font-[600] tabular ${derived.latestHourDelta < 0 ? "text-warn" : "text-ink"}`}>
                      {derived.latestHourDelta > 0 ? "+" : ""}
                      {derived.latestHourDelta}%
                    </dd>
                  </div>
                )}
              </dl>
            </Card>

            <Card className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-md font-[600] tracking-[-0.015em] text-ink">{t("platform.dashboard.fleetHealth")}</h2>
                  <p className="mt-1 text-sm text-ink-3">
                    {t("platform.dashboard.fleetHealthSubtitle")}
                  </p>
                </div>
                <StatusBadge tone="neutral" label={t("platform.dashboard.snapshotState", { time: statsFetchedAt })} />
              </div>

              <FleetHealthChart
                fleet={{
                  agents: {
                    total: stats?.agents.total ?? 0,
                    online: stats?.agents.online ?? 0,
                    offline: stats?.agents.offline ?? 0,
                  },
                  printers: {
                    total: stats?.printers.total ?? 0,
                    online: stats?.printers.online ?? 0,
                    offline: stats?.printers.offline ?? 0,
                  },
                }}
              />

              <div className="mt-5 grid grid-cols-2 gap-4 border-t border-edge-subtle pt-4">
                <div>
                  <div className="label-caps">{t("platform.dashboard.tenantsLabel")}</div>
                  <div className="mt-1 text-xl font-[640] tabular text-ink">{formatNumber(stats?.tenants.active ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-ink-3">{t("platform.dashboard.activeOfTotal", { total: formatNumber(stats?.tenants.total ?? 0) })}</div>
                </div>
                <div>
                  <div className="label-caps">{t("platform.dashboard.usersLabel")}</div>
                  <div className="mt-1 text-xl font-[640] tabular text-ink">{formatNumber(stats?.users.verified ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-ink-3">{t("platform.dashboard.verifiedOfTotal", { total: formatNumber(stats?.users.total ?? 0) })}</div>
                </div>
              </div>
            </Card>
          </section>

          <section className="grid grid-cols-1 gap-5 xl:grid-cols-[0.9fr_1.1fr]">
            <Card className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-md font-[600] tracking-[-0.015em] text-ink">{t("platform.dashboard.subscriptionHealth")}</h2>
                  <p className="mt-1 text-sm text-ink-3">
                    {t("platform.dashboard.subscriptionHealthSubtitle")}
                  </p>
                </div>
                <Link
                  href="/platform/subscriptions"
                  className="inline-flex shrink-0 items-center gap-1 text-sm font-[550] text-brand transition-colors hover:text-brand-hover"
                >
                  {t("platform.dashboard.manage")} <ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
                </Link>
              </div>
              <SubscriptionMixChart
                subscriptions={
                  stats?.subscriptions ?? {
                    total: 0,
                    active: 0,
                    trialing: 0,
                    pastDue: 0,
                    incomplete: 0,
                    incompleteExpired: 0,
                    unpaid: 0,
                    paused: 0,
                    cancelled: 0,
                    attention: 0,
                  }
                }
              />
            </Card>

            <Card>
              <CardHeader
                title={t("platform.dashboard.footprint")}
                icon={<Building2 className="h-4 w-4" />}
              />
              <div className="grid gap-3 px-5 py-5 sm:grid-cols-3">
                <div className="inset-panel p-4">
                  <div className="flex items-center gap-2 text-xs font-[550] text-ink-3">
                    <Building2 className="h-3.5 w-3.5" aria-hidden />
                    {t("platform.dashboard.tenantsLabel")}
                  </div>
                  <div className="mt-2 text-2xl font-[640] tabular text-ink">{formatNumber(stats?.tenants.total ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-ink-3">{t("platform.dashboard.tenantsCount", { count: formatNumber(stats?.tenants.active ?? 0) })}</div>
                </div>
                <div className="inset-panel p-4">
                  <div className="flex items-center gap-2 text-xs font-[550] text-ink-3">
                    <Users className="h-3.5 w-3.5" aria-hidden />
                    {t("platform.dashboard.usersLabel")}
                  </div>
                  <div className="mt-2 text-2xl font-[640] tabular text-ink">{formatNumber(stats?.users.total ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {t("platform.dashboard.usersVerified", { percent: formatNumber(percent(stats?.users.verified ?? 0, stats?.users.total ?? 0) ?? 0) })}
                  </div>
                </div>
                <div className="inset-panel p-4">
                  <div className="flex items-center gap-2 text-xs font-[550] text-ink-3">
                    <CreditCard className="h-3.5 w-3.5" aria-hidden />
                    {t("platform.dashboard.subscriptionsLabel")}
                  </div>
                  <div className="mt-2 text-2xl font-[640] tabular text-ink">{formatNumber(stats?.subscriptions.total ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-ink-3">{t("platform.dashboard.subscriptionsCount", { count: formatNumber(stats?.subscriptions.active ?? 0) })}</div>
                </div>
              </div>
            </Card>
          </section>

          <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card className="overflow-hidden">
              <CardHeader
                title={t("platform.dashboard.latestTenants")}
                actions={
                  <Button variant="ghost" size="sm" href="/platform/tenants">
                    {t("platform.dashboard.viewAll")}
                  </Button>
                }
              />
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption className="sr-only">{t("platform.dashboard.tableTenants")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("platform.dashboard.tenant")}</th>
                      <th scope="col">{t("platform.dashboard.status")}</th>
                      <th scope="col" className="text-end">{t("platform.dashboard.created")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="py-6">
                          <EmptyState
                            size="sm"
                            icon={<Building2 className="h-4 w-4" />}
                            title={t("platform.dashboard.noTenants")}
                            description={t("platform.dashboard.noTenantsBody")}
                          />
                        </td>
                      </tr>
                    ) : (
                      tenants.slice(0, 5).map((tenant) => {
                        const meta = LIFECYCLE_META[tenant.lifecycle];
                        return (
                          <tr key={tenant.id}>
                            <td>
                              <div className="text-sm font-[550] text-ink">{tenant.name}</div>
                              <div className="mt-0.5 font-mono text-2xs text-ink-4">{tenant.id}</div>
                            </td>
                            <td>
                              <StatusBadge tone={meta.tone} label={t(meta.key)} size="sm" />
                            </td>
                            <td className="text-end text-sm text-ink-3">
                              {formatDate(tenant.createdAt)}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader
                title={t("platform.dashboard.latestSubscriptions")}
                actions={
                  <Button variant="ghost" size="sm" href="/platform/subscriptions">
                    {t("platform.dashboard.viewAll")}
                  </Button>
                }
              />
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption className="sr-only">{t("platform.dashboard.latestSubscriptions")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("platform.dashboard.tenant")}</th>
                      <th scope="col">{t("platform.dashboard.plan")}</th>
                      <th scope="col">{t("platform.dashboard.status")}</th>
                      <th scope="col" className="text-end">{t("platform.dashboard.created")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subscriptions.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-6">
                          <EmptyState
                            size="sm"
                            icon={<CreditCard className="h-4 w-4" />}
                            title={t("platform.dashboard.noSubscriptions")}
                            description={t("platform.dashboard.noSubscriptionsBody")}
                          />
                        </td>
                      </tr>
                    ) : (
                      subscriptions.slice(0, 5).map((subscription) => {
                        const meta = SUBSCRIPTION_META[subscription.status];
                        return (
                          <tr key={subscription.tenantId}>
                            <td>
                              <div className="text-sm font-[550] text-ink">{subscription.tenantName}</div>
                              <div className="mt-0.5 font-mono text-2xs text-ink-4">
                                {subscription.stripeSubscriptionId
                                  ? `${subscription.stripeSubscriptionId.slice(0, 16)}…`
                                  : t("platform.dashboard.noStripeSubscription")}
                              </div>
                            </td>
                            <td className="text-sm text-ink-2">{subscription.planName || t("platform.dashboard.noPlan")}</td>
                            <td>
                              <StatusBadge tone={meta.tone} label={t(meta.key)} size="sm" />
                            </td>
                            <td className="text-end text-sm text-ink-3">
                              {formatDate(subscription.createdAt)}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
