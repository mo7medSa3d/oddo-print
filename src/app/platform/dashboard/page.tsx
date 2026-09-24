"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, Building2, CreditCard, RefreshCw, ShieldCheck, Users } from "lucide-react";
import {
  FleetHealthChart,
  OperationalSignals,
  PrintThroughputChart,
  SubscriptionMixChart,
  type OverviewHourlyPoint,
} from "../../../components/platform/overview-charts";

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

function SubscriptionStatus({
  status,
}: {
  status: SubscriptionRow["status"];
}) {
  const styles = {
    active: "bg-ok-bg text-ok",
    trialing: "bg-info-bg text-info",
    past_due: "bg-warn-bg text-warn",
    incomplete: "bg-warn-bg text-warn",
    incomplete_expired: "bg-warn-bg text-warn",
    unpaid: "bg-bad-bg text-bad",
    paused: "bg-surface-3 text-ink-3",
    cancelled: "bg-bad-bg text-bad",
  } as const;

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${styles[status]}`}>
      {status.replace("_", " ")}
    </span>
  );
}

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
    <div className="space-y-7">
      <header className="flex flex-col gap-5 border-b border-edge pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-display">Overview</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-ok-edge bg-ok-bg px-2.5 py-1 text-[11px] font-semibold text-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-ok-solid" />
              Control plane
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setReloadKey((value) => value + 1);
            }}
            disabled={loading}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-edge bg-surface px-3.5 text-[13px] font-medium text-ink-2 shadow-xs transition hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
          <Link
            href="/platform/audit"
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-[13px] font-semibold text-brand-contrast shadow-xs transition hover:bg-brand-hover"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            Security audit
          </Link>
        </div>
      </header>

      {error && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-bad-edge bg-bad-bg px-4 py-3.5 text-[13px] text-bad">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="font-semibold underline">
            Retry
          </button>
        </div>
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
        <div className="card p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-brand" aria-hidden />
                <h2 className="text-[17px] font-semibold text-ink">Print throughput</h2>
              </div>
              <p className="mt-1 text-[12px] text-ink-4">
                Hourly print volume and outcome mix across the gateway.
              </p>
            </div>
            <div className="text-left sm:text-right">
              <div className="text-[24px] font-bold tracking-[-0.03em] text-ink tabular-nums">
                {formatNumber(stats?.jobs24h.total ?? 0)}
              </div>
              <div className="mt-1 text-[11px] text-ink-4">
                jobs in 24h
                {derived.jobSuccessRate !== null ? ` · ${derived.jobSuccessRate}% successful` : ""}
              </div>
            </div>
          </div>

          {derived.hourlyHasData ? (
            <PrintThroughputChart data={stats?.jobs24hHourly ?? []} />
          ) : (
            <div className="mt-5 flex h-[260px] items-center justify-center rounded-xl border border-dashed border-edge bg-surface-2 px-6 text-center">
              <div>
                <div className="text-[13px] font-semibold text-ink">No print activity yet</div>
                <div className="mt-1 text-[12px] text-ink-4">The throughput chart will populate as jobs enter the gateway.</div>
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-edge pt-4 text-[11px] text-ink-4">
            <span>{formatNumber(stats?.jobs24h.success ?? 0)} successful</span>
            <span>{formatNumber(stats?.jobs24h.failed ?? 0)} failed</span>
            <span>{formatNumber(stats?.jobs24h.expired ?? 0)} expired</span>
            <span>{formatNumber((stats?.jobs24h.queued ?? 0) + (stats?.jobs24h.inFlight ?? 0))} currently open</span>
            {derived.latestHourDelta !== null && (
              <span className={derived.latestHourDelta < 0 ? "text-warn" : "text-ink-3"}>
                Latest hour {derived.latestHourDelta > 0 ? "+" : ""}{derived.latestHourDelta}% vs previous
              </span>
            )}
          </div>
        </div>

        <div className="card p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[17px] font-semibold text-ink">Fleet health</h2>
              <p className="mt-1 text-[12px] text-ink-4">
                Runtime availability derived from recent agent heartbeats.
              </p>
            </div>
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-4">
              Live state
            </span>
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

          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-edge pt-5">
            <div>
              <div className="text-[11px] uppercase tracking-[0.08em] text-ink-4">Tenants</div>
              <div className="mt-1 text-lg font-bold tabular-nums text-ink">{formatNumber(stats?.tenants.active ?? 0)}</div>
              <div className="text-[11px] text-ink-4">active of {formatNumber(stats?.tenants.total ?? 0)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.08em] text-ink-4">Users</div>
              <div className="mt-1 text-lg font-bold tabular-nums text-ink">{formatNumber(stats?.users.verified ?? 0)}</div>
              <div className="text-[11px] text-ink-4">verified of {formatNumber(stats?.users.total ?? 0)}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="card p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[17px] font-semibold text-ink">Subscription health</h2>
              <p className="mt-1 text-[12px] text-ink-4">
                Current lifecycle mix, with past-due accounts isolated for follow-up.
              </p>
            </div>
            <Link href="/platform/subscriptions" className="text-[12px] font-semibold text-brand hover:text-brand-hover">
              Manage
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
        </div>

        <div className="card p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[17px] font-semibold text-ink">Platform footprint</h2>
              <p className="mt-1 text-[12px] text-ink-4">
                The business surface behind the runtime: customers, users, and connected infrastructure.
              </p>
            </div>
            <Building2 className="h-5 w-5 text-brand" aria-hidden />
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <div className="inset-panel p-4">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">
                <Building2 className="h-3.5 w-3.5" aria-hidden />
                Tenants
              </div>
              <div className="mt-2 text-2xl font-bold tabular-nums text-ink">{formatNumber(stats?.tenants.total ?? 0)}</div>
              <div className="mt-1 text-[11px] text-ink-4">{formatNumber(stats?.tenants.active ?? 0)} active</div>
            </div>
            <div className="inset-panel p-4">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">
                <Users className="h-3.5 w-3.5" aria-hidden />
                Users
              </div>
              <div className="mt-2 text-2xl font-bold tabular-nums text-ink">{formatNumber(stats?.users.total ?? 0)}</div>
              <div className="mt-1 text-[11px] text-ink-4">
                {percent(stats?.users.verified ?? 0, stats?.users.total ?? 0) ?? 0}% verified
              </div>
            </div>
            <div className="inset-panel p-4">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">
                <CreditCard className="h-3.5 w-3.5" aria-hidden />
                Plans
              </div>
              <div className="mt-2 text-2xl font-bold tabular-nums text-ink">{formatNumber(stats?.subscriptions.total ?? 0)}</div>
              <div className="mt-1 text-[11px] text-ink-4">{formatNumber(stats?.subscriptions.active ?? 0)} active</div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-edge px-6 py-5">
            <div>
              <h2 className="text-[16px] font-semibold text-ink">Latest tenants</h2>
            </div>
            <Link href="/platform/tenants" className="text-[12px] font-semibold text-brand hover:text-brand-hover">
              View all
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="data-table text-left text-[13px]">
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Status</th>
                  <th className="text-right">Created</th>
                </tr>
              </thead>
              <tbody>
                {tenants.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-10 text-center text-[12px] text-ink-4">
                      No tenant records found.
                    </td>
                  </tr>
                ) : (
                  tenants.slice(0, 5).map((tenant) => {
                    const lifecycleStyles = {
                      active: "bg-ok-bg text-ok",
                      suspended: "bg-warn-bg text-warn",
                      deleted: "bg-bad-bg text-bad",
                    } as const;

                    return (
                      <tr key={tenant.id} className="table-row">
                        <td>
                          <div className="font-semibold text-ink">{tenant.name}</div>
                          <div className="mt-0.5 font-mono text-[10px] text-ink-4">{tenant.id}</div>
                        </td>
                        <td>
                          <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${lifecycleStyles[tenant.lifecycle]}`}>
                            {tenant.lifecycle}
                          </span>
                        </td>
                        <td className="text-right text-[12px] text-ink-3">
                          {new Date(tenant.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-edge px-6 py-5">
            <div>
              <h2 className="text-[16px] font-semibold text-ink">Latest subscriptions</h2>
            </div>
            <Link href="/platform/subscriptions" className="text-[12px] font-semibold text-brand hover:text-brand-hover">
              View all
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="data-table text-left text-[13px]">
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th className="text-right">Created</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-10 text-center text-[12px] text-ink-4">
                      No subscription records found.
                    </td>
                  </tr>
                ) : (
                  subscriptions.slice(0, 5).map((subscription) => (
                    <tr key={subscription.tenantId} className="table-row">
                      <td>
                        <div className="font-semibold text-ink">{subscription.tenantName}</div>
                        <div className="mt-0.5 font-mono text-[10px] text-ink-4">
                          {subscription.stripeSubscriptionId ? `${subscription.stripeSubscriptionId.slice(0, 16)}…` : "No Stripe subscription"}
                        </div>
                      </td>
                      <td className="font-medium text-ink-2">
                        {subscription.planName || "No plan"}
                      </td>
                      <td>
                        <SubscriptionStatus status={subscription.status} />
                      </td>
                      <td className="text-right text-[12px] text-ink-3">
                        {new Date(subscription.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
