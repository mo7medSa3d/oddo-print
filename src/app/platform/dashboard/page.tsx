"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { BadgeCheck, Building2, CalendarClock, ClipboardList, KeyRound, Server } from "lucide-react";
import { Button, ErrorState, LoadingState, PageHeader } from "../../../components/ui";
import { AdminMetric, adminJson } from "../../../components/platform/ManualAdmin";
import { useI18n } from "../../../i18n/react";

type Stats = {
  tenants: { total: number; suspended: number };
  business: { active: number; pendingRequests: number; free: number; paid: number; expiringSoon: number; suspended: number };
  licenseKeys: { total: number; active: number; grace: number; revoked: number };
  integrations: {
    keys: { total: number; active: number; grace: number; revoked: number };
    installations: { total: number; enabled: number; quarantined: number };
  };
  users: { total: number; verified: number };
};

export default function PlatformDashboard() {
  const { t, formatNumber } = useI18n();
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    adminJson('/api/platform/stats', { signal: controller.signal }).then((result: Stats) => {
      if (live) { setData(result); setError(false); }
    }).catch(() => {
      // Do not keep presenting previously fetched control-plane metrics as
      // current after the authenticated refresh failed.
      if (live) { setData(null); setError(true); }
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; controller.abort(); };
  }, [tick]);

  function refresh() {
    setLoading(true);
    setError(false);
    setTick(x => x + 1);
  }

  return <div className="space-y-5">
    <PageHeader variant="inline" title={t("v4.admin.overview")} description={t("gateway.platform.dashboardSubtitle")} actions={<Button disabled={loading} loading={loading} onClick={refresh}>{t("v4.admin.refresh")}</Button>} />
    {error && <ErrorState title={t("v4.admin.overview")} message={t("v4.admin.loadError")} retry={refresh} />}
    {!data
      ? (error ? null : <div role="status" aria-busy="true" aria-label={t("v4.admin.loading")}><LoadingState rows={4} /></div>)
      : <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <AdminMetric label={t("v4.admin.totalWorkspaces")} value={formatNumber(data.tenants.total)} icon={<Building2 className="h-5 w-5" />}
            detail={<Link className="font-medium text-brand hover:underline" href="/platform/tenants">{t("v4.admin.workspaces")}</Link>} />
          <AdminMetric label={t("v4.admin.activeWorkspaces")} value={formatNumber(data.business.active)} icon={<BadgeCheck className="h-5 w-5" />}
            detail={`${t("v4.admin.freePaid")}: ${formatNumber(data.business.free)} / ${formatNumber(data.business.paid)}`} />
          <AdminMetric label={t("v4.admin.pendingRequests")} value={formatNumber(data.business.pendingRequests)} icon={<ClipboardList className="h-5 w-5" />}
            detail={<Link className="font-semibold text-brand hover:underline" href="/platform/subscription-requests">{t("v4.admin.review")}</Link>} />
          <AdminMetric label={t("v4.admin.expiring")} value={formatNumber(data.business.expiringSoon)} icon={<CalendarClock className="h-5 w-5" />}
            detail={<Link className="font-medium text-brand hover:underline" href="/platform/subscriptions">{t("v4.admin.manage")}</Link>} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <AdminMetric
            label={t("apiKeys.credentials")}
            value={`${formatNumber(data.licenseKeys.active)} / ${formatNumber(data.licenseKeys.total)}`}
            icon={<KeyRound className="h-5 w-5" />}
            detail={<Link className="font-medium text-brand hover:underline" href="/platform/integrations">{t("v4.admin.integrations")}</Link>}
          />
          <AdminMetric
            label={t("apiKeys.title")}
            value={`${formatNumber(data.integrations.installations.enabled)} / ${formatNumber(data.integrations.installations.total)}`}
            icon={<Server className="h-5 w-5" />}
            detail={<Link className="font-medium text-brand hover:underline" href="/platform/subscriptions">{t("v4.admin.subscriptions")}</Link>}
          />
        </div>
      </>}
  </div>;
}
