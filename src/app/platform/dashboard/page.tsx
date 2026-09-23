"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  Building2,
    CreditCard,
  Printer,
  RefreshCw,
  ShieldCheck,
  Users,
  Wifi,
} from "lucide-react";

type Stats = {
  tenants: { total: number; active: number; suspended: number; deleted: number };
  subscriptions: { total: number; active: number; trialing: number; pastDue: number; cancelled: number };
  users: { total: number; verified: number };
  agents: { total: number; online: number; offline: number };
  printers: { total: number; online: number; offline: number };
  jobs24h: { total: number; success: number; failed: number; queued: number; inFlight: number; expired: number };
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
  status: "trialing" | "active" | "past_due" | "paused" | "cancelled";
  createdAt: string;
};

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function percent(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : null;
}

function MetricCard({
  label,
  value,
  icon: Icon,
  detail,
}: {
  label: string;
  value: number;
  icon: typeof Activity;
  detail: React.ReactNode;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-subtle text-brand-subtle-text">
          <Icon className="h-4.5 w-4.5" aria-hidden />
        </div>
      </div>
      <div className="mt-4">
        <div className="label-caps normal-case tracking-normal">{label}</div>
        <div className="mt-1 text-[30px] font-bold tracking-[-0.03em] text-ink tabular-nums">
          {formatNumber(value)}
        </div>
        <div className="mt-2 text-[12px] text-ink-3">{detail}</div>
      </div>
    </div>
  );
}

function HealthRow({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: "ok" | "info" | "warn";
}) {
  const rate = percent(value, total);
  const toneClasses = {
    ok: "bg-ok-solid",
    info: "bg-info-solid",
    warn: "bg-warn-solid",
  } as const;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 text-[13px]">
        <span className="font-medium text-ink-2">{label}</span>
        <span className="tabular-nums text-ink-3">
          {formatNumber(value)} / {formatNumber(total)}
          {rate !== null ? ` · ${rate}%` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${toneClasses[tone]}`}
          style={{ width: `${rate ?? 0}%` }}
        />
      </div>
    </div>
  );
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
    const tenantsTotal = stats?.tenants.total ?? 0;
    const usersTotal = stats?.users.total ?? 0;
    const agentsTotal = stats?.agents.total ?? 0;
    const printersTotal = stats?.printers.total ?? 0;
    const terminalJobs = (stats?.jobs24h.success ?? 0) + (stats?.jobs24h.failed ?? 0) + (stats?.jobs24h.expired ?? 0);

    return {
      activeTenantRate: percent(stats?.tenants.active ?? 0, tenantsTotal),
      verifiedUserRate: percent(stats?.users.verified ?? 0, usersTotal),
      onlineAgentRate: percent(stats?.agents.online ?? 0, agentsTotal),
      onlinePrinterRate: percent(stats?.printers.online ?? 0, printersTotal),
      jobSuccessRate: percent(stats?.jobs24h.success ?? 0, terminalJobs),
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

      <section aria-label="Platform totals" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Tenants"
          value={stats?.tenants.total ?? 0}
          icon={Building2}
          detail={`${formatNumber(stats?.tenants.active ?? 0)} active · ${formatNumber(stats?.tenants.suspended ?? 0)} suspended`}
        />
        <MetricCard
          label="Users"
          value={stats?.users.total ?? 0}
          icon={Users}
          detail={derived.verifiedUserRate === null ? "No verified users recorded" : `${formatNumber(stats?.users.verified ?? 0)} verified · ${derived.verifiedUserRate}% of users`}
        />
        <MetricCard
          label="Subscriptions"
          value={stats?.subscriptions.total ?? 0}
          icon={CreditCard}
          detail={`${formatNumber(stats?.subscriptions.active ?? 0)} active · ${formatNumber(stats?.subscriptions.trialing ?? 0)} trialing`}
        />
        <MetricCard
          label="Agents"
          value={stats?.agents.total ?? 0}
          icon={Wifi}
          detail={`${formatNumber(stats?.agents.online ?? 0)} online · ${formatNumber(stats?.agents.offline ?? 0)} offline`}
        />
        <MetricCard
          label="Printers"
          value={stats?.printers.total ?? 0}
          icon={Printer}
          detail={`${formatNumber(stats?.printers.online ?? 0)} online · ${formatNumber(stats?.printers.offline ?? 0)} offline`}
        />
        <MetricCard
          label="Print jobs · 24h"
          value={stats?.jobs24h.total ?? 0}
          icon={Activity}
          detail={`${formatNumber(stats?.jobs24h.success ?? 0)} success · ${formatNumber(stats?.jobs24h.failed ?? 0)} failed · ${formatNumber((stats?.jobs24h.queued ?? 0) + (stats?.jobs24h.inFlight ?? 0))} open`}
        />
      </section>

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="card p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[17px] font-semibold text-ink">Operational coverage</h2>
            </div>
            <Activity className="mt-0.5 h-5 w-5 text-brand" aria-hidden />
          </div>

          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <HealthRow
              label="Active tenants"
              value={stats?.tenants.active ?? 0}
              total={stats?.tenants.total ?? 0}
              tone="ok"
            />
            <HealthRow
              label="Verified users"
              value={stats?.users.verified ?? 0}
              total={stats?.users.total ?? 0}
              tone="info"
            />
            <HealthRow
              label="Agents online"
              value={stats?.agents.online ?? 0}
              total={stats?.agents.total ?? 0}
              tone="ok"
            />
            <HealthRow
              label="Printers online"
              value={stats?.printers.online ?? 0}
              total={stats?.printers.total ?? 0}
              tone="ok"
            />
          </div>
        </div>

        <div className="card p-6">
          <div>
            <h2 className="text-[17px] font-semibold text-ink">Print activity · last 24 hours</h2>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="inset-panel p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">Success state</div>
              <div className="mt-2 text-2xl font-bold tabular-nums text-ink">{formatNumber(stats?.jobs24h.success ?? 0)}</div>
              <div className="mt-1 text-[11px] text-ok">
                {derived.jobSuccessRate === null ? "No terminal jobs" : `${derived.jobSuccessRate}% of terminal jobs`}
              </div>
            </div>
            <div className="inset-panel p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">Failed</div>
              <div className="mt-2 text-2xl font-bold tabular-nums text-ink">{formatNumber(stats?.jobs24h.failed ?? 0)}</div>
              <div className="mt-1 text-[11px] text-bad">Recorded failures</div>
            </div>
            <div className="inset-panel p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">Open</div>
              <div className="mt-2 text-2xl font-bold tabular-nums text-ink">{formatNumber((stats?.jobs24h.queued ?? 0) + (stats?.jobs24h.inFlight ?? 0))}</div>
              <div className="mt-1 text-[11px] text-warn">{formatNumber(stats?.jobs24h.queued ?? 0)} queued · {formatNumber(stats?.jobs24h.inFlight ?? 0)} in flight</div>
            </div>
          </div>

          <div className="mt-5 space-y-2">
            {[
              ["Success", stats?.jobs24h.success ?? 0, "bg-ok-solid"],
              ["Failed", stats?.jobs24h.failed ?? 0, "bg-bad-solid"],
              ["Open", (stats?.jobs24h.queued ?? 0) + (stats?.jobs24h.inFlight ?? 0), "bg-warn-solid"],
              ["Expired", stats?.jobs24h.expired ?? 0, "bg-info-solid"],
            ].map(([label, value, barClass]) => {
              const total = stats?.jobs24h.total ?? 0;
              const width = total > 0 ? ((value as number) / total) * 100 : 0;
              return (
                <div key={label as string} className="flex items-center gap-3 text-[12px]">
                  <span className="w-16 text-ink-3">{label as string}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                    <div className={`h-full rounded-full ${barClass as string}`} style={{ width: `${width}%` }} />
                  </div>
                  <span className="w-10 text-right tabular-nums text-ink-3">{formatNumber(value as number)}</span>
                </div>
              );
            })}
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
