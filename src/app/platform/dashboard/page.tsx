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
  Card,
  CardHeader,
  PageHeader,
  EmptyState,
  ErrorState,
  PageSkeleton,
  StatusBadge,
  type Tone,
} from "../../../components/ui";

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

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function percent(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : null;
}

const SUBSCRIPTION_META: Record<SubscriptionRow["status"], { tone: Tone; label: string }> = {
  active: { tone: "ok", label: "Active" },
  trialing: { tone: "info", label: "Trialing" },
  past_due: { tone: "warn", label: "Past due" },
  incomplete: { tone: "warn", label: "Incomplete" },
  incomplete_expired: { tone: "warn", label: "Expired" },
  unpaid: { tone: "bad", label: "Unpaid" },
  paused: { tone: "neutral", label: "Paused" },
  cancelled: { tone: "bad", label: "Cancelled" },
};

const LIFECYCLE_META: Record<TenantRow["lifecycle"], { tone: Tone; label: string }> = {
  active: { tone: "ok", label: "Active" },
  suspended: { tone: "warn", label: "Suspended" },
  deleted: { tone: "bad", label: "Deleted" },
};

export default function PlatformDashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
          throw new Error("Failed to load platform statistics");
        }

        const statsData = (await statsRes.json()) as Stats;
        const tenantsData = tenantsRes.ok ? await tenantsRes.json() : { tenants: [] };
        const subscriptionsData = subsRes.ok ? await subsRes.json() : { subscriptions: [] };

        if (!ignore) {
          setStats(statsData);
          setTenants(Array.isArray(tenantsData.tenants) ? tenantsData.tenants : []);
          setSubscriptions(
            Array.isArray(subscriptionsData.subscriptions) ? subscriptionsData.subscriptions : [],
          );
          setError(null);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Error loading platform statistics");
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();

    return () => {
      ignore = true;
    };
  }, [router, reloadKey]);

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
        eyebrow="Control plane"
        title="Platform overview"
        description="Tenants, subscriptions and runtime activity across every workspace on this Gateway."
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
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
            <Button variant="primary" href="/platform/audit" icon={<ShieldCheck className="h-4 w-4" aria-hidden />}>
              Security audit
            </Button>
          </>
        }
      />

      {loading && !stats ? (
        <div role="status" aria-label="Loading platform statistics">
          <PageSkeleton />
          <span className="sr-only">Loading platform statistics…</span>
        </div>
      ) : (
        <>
          {error && (
            <ErrorState
              title="Platform statistics unavailable"
              message={error}
              retry={() => {
                setLoading(true);
                setReloadKey((value) => value + 1);
              }}
            />
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
                    Print throughput
                  </h2>
                  <p className="mt-1 text-sm text-ink-3">
                    Hourly print volume and outcome mix across the gateway.
                  </p>
                </div>
                <div className="text-start sm:text-end">
                  <div className="text-3xl font-[660] leading-none tracking-[-0.03em] text-ink tabular">
                    {formatNumber(stats?.jobs24h.total ?? 0)}
                  </div>
                  <div className="mt-1.5 text-xs text-ink-3">
                    jobs in 24h
                    {derived.jobSuccessRate !== null ? ` · ${derived.jobSuccessRate}% successful` : ""}
                  </div>
                </div>
              </div>

              {derived.hourlyHasData ? (
                <PrintThroughputChart data={stats?.jobs24hHourly ?? []} />
              ) : (
                <EmptyState
                  className="mt-4 rounded-sg border border-dashed border-edge-strong bg-surface-2"
                  icon={<Activity className="h-5 w-5" />}
                  title="No print activity yet"
                  description="The throughput chart populates as jobs enter the gateway. Nothing is simulated."
                />
              )}

              <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-edge-subtle pt-4 text-xs text-ink-3">
                <div className="flex items-center gap-1.5">
                  <dt>Successful</dt>
                  <dd className="font-[600] tabular text-ink">{formatNumber(stats?.jobs24h.success ?? 0)}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt>Failed</dt>
                  <dd className="font-[600] tabular text-ink">{formatNumber(stats?.jobs24h.failed ?? 0)}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt>Expired</dt>
                  <dd className="font-[600] tabular text-ink">{formatNumber(stats?.jobs24h.expired ?? 0)}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt>Open now</dt>
                  <dd className="font-[600] tabular text-ink">
                    {formatNumber((stats?.jobs24h.queued ?? 0) + (stats?.jobs24h.inFlight ?? 0))}
                  </dd>
                </div>
                {derived.latestHourDelta !== null && (
                  <div className="flex items-center gap-1.5">
                    <dt>Latest hour vs previous</dt>
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
                  <h2 className="text-md font-[600] tracking-[-0.015em] text-ink">Fleet health</h2>
                  <p className="mt-1 text-sm text-ink-3">
                    Runtime availability derived from recent agent heartbeats.
                  </p>
                </div>
                <StatusBadge tone="ok" label="Live state" pulse />
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
                  <div className="label-caps">Tenants</div>
                  <div className="mt-1 text-xl font-[640] tabular text-ink">{formatNumber(stats?.tenants.active ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-ink-3">active of {formatNumber(stats?.tenants.total ?? 0)}</div>
                </div>
                <div>
                  <div className="label-caps">Users</div>
                  <div className="mt-1 text-xl font-[640] tabular text-ink">{formatNumber(stats?.users.verified ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-ink-3">verified of {formatNumber(stats?.users.total ?? 0)}</div>
                </div>
              </div>
            </Card>
          </section>

          <section className="grid grid-cols-1 gap-5 xl:grid-cols-[0.9fr_1.1fr]">
            <Card className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-md font-[600] tracking-[-0.015em] text-ink">Subscription health</h2>
                  <p className="mt-1 text-sm text-ink-3">
                    Current lifecycle mix, with past-due accounts isolated for follow-up.
                  </p>
                </div>
                <Link
                  href="/platform/subscriptions"
                  className="inline-flex shrink-0 items-center gap-1 text-sm font-[550] text-brand transition-colors hover:text-brand-hover"
                >
                  Manage <ArrowRight className="h-3.5 w-3.5" aria-hidden />
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
                title="Platform footprint"
                subtitle="The business surface behind the runtime: customers, users and connected infrastructure."
                icon={<Building2 className="h-4 w-4" />}
              />
              <div className="grid gap-3 px-5 py-5 sm:grid-cols-3">
                <div className="inset-panel p-4">
                  <div className="flex items-center gap-2 text-2xs font-[600] uppercase tracking-[0.08em] text-ink-3">
                    <Building2 className="h-3.5 w-3.5" aria-hidden />
                    Tenants
                  </div>
                  <div className="mt-2 text-2xl font-[640] tabular text-ink">{formatNumber(stats?.tenants.total ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-ink-3">{formatNumber(stats?.tenants.active ?? 0)} active</div>
                </div>
                <div className="inset-panel p-4">
                  <div className="flex items-center gap-2 text-2xs font-[600] uppercase tracking-[0.08em] text-ink-3">
                    <Users className="h-3.5 w-3.5" aria-hidden />
                    Users
                  </div>
                  <div className="mt-2 text-2xl font-[640] tabular text-ink">{formatNumber(stats?.users.total ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {percent(stats?.users.verified ?? 0, stats?.users.total ?? 0) ?? 0}% verified
                  </div>
                </div>
                <div className="inset-panel p-4">
                  <div className="flex items-center gap-2 text-2xs font-[600] uppercase tracking-[0.08em] text-ink-3">
                    <CreditCard className="h-3.5 w-3.5" aria-hidden />
                    Subscriptions
                  </div>
                  <div className="mt-2 text-2xl font-[640] tabular text-ink">{formatNumber(stats?.subscriptions.total ?? 0)}</div>
                  <div className="mt-0.5 text-xs text-ink-3">{formatNumber(stats?.subscriptions.active ?? 0)} active</div>
                </div>
              </div>
            </Card>
          </section>

          <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card className="overflow-hidden">
              <CardHeader
                title="Latest tenants"
                subtitle="Newest workspaces to join the platform."
                actions={
                  <Button variant="ghost" size="sm" href="/platform/tenants">
                    View all
                  </Button>
                }
              />
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption className="sr-only">Latest tenants</caption>
                  <thead>
                    <tr>
                      <th scope="col">Tenant</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="text-end">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="py-6">
                          <EmptyState
                            size="sm"
                            icon={<Building2 className="h-4 w-4" />}
                            title="No tenants yet"
                            description="Workspaces appear the moment a customer completes signup."
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
                              <StatusBadge tone={meta.tone} label={meta.label} size="sm" />
                            </td>
                            <td className="text-end text-sm text-ink-3">
                              {new Date(tenant.createdAt).toLocaleDateString()}
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
                title="Latest subscriptions"
                subtitle="Most recent commerce events per tenant."
                actions={
                  <Button variant="ghost" size="sm" href="/platform/subscriptions">
                    View all
                  </Button>
                }
              />
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption className="sr-only">Latest subscriptions</caption>
                  <thead>
                    <tr>
                      <th scope="col">Tenant</th>
                      <th scope="col">Plan</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="text-end">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subscriptions.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-6">
                          <EmptyState
                            size="sm"
                            icon={<CreditCard className="h-4 w-4" />}
                            title="No subscriptions yet"
                            description="Stripe subscriptions appear here as soon as checkout completes."
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
                                  : "No Stripe subscription"}
                              </div>
                            </td>
                            <td className="text-sm text-ink-2">{subscription.planName || "No plan"}</td>
                            <td>
                              <StatusBadge tone={meta.tone} label={meta.label} size="sm" />
                            </td>
                            <td className="text-end text-sm text-ink-3">
                              {new Date(subscription.createdAt).toLocaleDateString()}
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
