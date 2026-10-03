"use client";

import { useEffect, useState } from "react";
import { Building2, RefreshCw, Search, X, MoreHorizontal, AlertOctagon, RotateCcw, Ban } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardHeader,
  PageHeader,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Menu,
  Modal,
  StatusBadge,
  TableSkeleton,
  Textarea,
  type MenuItemSpec,
  type Tone,
} from "../../../components/ui";
import { useI18n } from "../../../i18n/react";
import type { MessageKey } from "../../../i18n/messages/en";

type Tenant = {
  id: string;
  name: string;
  lifecycle: "active" | "suspended" | "deleted";
  lifecycleReason: string | null;
  suspendedAt: string | null;
  createdAt: string;
  subscriptionStatus: string | null;
  planName: string | null;
  memberCount: number;
  agentCount: number;
  printerCount: number;
};

type DialogMode = "suspend" | "reactivate";

const LIFECYCLE_META: Record<Tenant["lifecycle"], { tone: Tone; key: MessageKey }> = {
  active: { tone: "ok", key: "platform.tenants.lifecycle.active" },
  suspended: { tone: "warn", key: "platform.tenants.lifecycle.suspended" },
  deleted: { tone: "bad", key: "platform.tenants.lifecycle.deleted" },
};

export default function PlatformTenantsPage() {
  const { t, tc, formatNumber, formatDate } = useI18n();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode>("suspend");
  const [suspendReason, setSuspendReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/platform/tenants", { cache: "no-store" });
        if (ignore) return;
        if (!res.ok) throw new Error(t("platform.tenants.loadFailed"));
        const data = await res.json();
        if (!ignore) { setTenants(Array.isArray(data.tenants) ? data.tenants : []); setError(null); }
      } catch {
        if (!ignore) setError(t("platform.tenants.loadFailed"));
      } finally { if (!ignore) setLoading(false); }
    }
    void load();
    return () => { ignore = true; };
  }, [reloadKey, t]);

  function closeDialog() {
    if (actionLoading) return;
    setSelectedTenant(null);
    setSuspendReason("");
    setActionError(null);
  }

  function handleRefresh() { setLoading(true); setError(null); setNotice(null); setReloadKey((k) => k + 1); }
  function openSuspend(tenant: Tenant) { setSelectedTenant(tenant); setDialogMode("suspend"); setSuspendReason(""); setActionError(null); }
  function openReactivate(tenant: Tenant) { setSelectedTenant(tenant); setDialogMode("reactivate"); setSuspendReason(""); setActionError(null); }

  async function handleLifecycleAction() {
    if (!selectedTenant) return;
    const reason = suspendReason.trim();
    if (dialogMode === "suspend" && !reason) { setActionError(t("platform.tenants.reasonMissing")); return; }
    setActionLoading(true); setActionError(null); setNotice(null);
    const nextLifecycle = dialogMode === "suspend" ? "suspended" : "active";
    try {
      const endpoint = dialogMode === "suspend" ? `/api/platform/tenants/${selectedTenant.id}/suspend` : `/api/platform/tenants/${selectedTenant.id}/reactivate`;
      const options: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" } };
      if (dialogMode === "suspend") options.body = JSON.stringify({ reason });
      const res = await fetch(endpoint, options);
      if (!res.ok) throw new Error(t("platform.tenants.actionFailedBody"));
      const tenantName = selectedTenant.name;
      setSelectedTenant(null); setSuspendReason(""); setActionError(null);
      setNotice(
        nextLifecycle === "suspended"
          ? t("platform.tenants.noticeSuspended", { name: tenantName })
          : t("platform.tenants.noticeReactivated", { name: tenantName }),
      );
      handleRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : t("platform.tenants.actionFailedBody"));
    } finally { setActionLoading(false); }
  }

  const filtered = tenants.filter((tenant) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return tenant.name.toLowerCase().includes(query) || tenant.id.toLowerCase().includes(query);
  });

  const activeCount = tenants.filter((t) => t.lifecycle === "active").length;
  const suspendedCount = tenants.filter((t) => t.lifecycle === "suspended").length;

  const tenantMenu = (tenant: Tenant): MenuItemSpec[] =>
    tenant.lifecycle === "active"
      ? [
          {
            key: "suspend",
            label: t("platform.tenants.menu.suspend"),
            icon: <AlertOctagon className="h-4 w-4" />,
            tone: "danger",
            disabled: actionLoading,
            onSelect: () => openSuspend(tenant),
          },
        ]
      : tenant.lifecycle === "suspended"
        ? [
            {
              key: "reactivate",
              label: t("platform.tenants.menu.reactivate"),
              icon: <RotateCcw className="h-4 w-4" />,
              disabled: actionLoading,
              onSelect: () => openReactivate(tenant),
            },
          ]
        : [];

  return (
    <div className="space-y-5">
      <PageHeader
        variant="inline"
        eyebrow={t("platform.tenants.eyebrow")}
        icon={<Building2 className="h-4 w-4" aria-hidden />}
        title={t("platform.tenants.title")}
        description={t("platform.tenants.description")}
        actions={
          <>
            {suspendedCount > 0 && <StatusBadge tone="warn" label={t("platform.tenants.suspendedCount", { count: formatNumber(suspendedCount) })} />}
            <Button
              variant="secondary"
              onClick={handleRefresh}
              disabled={loading}
              loading={loading}
              icon={loading ? undefined : <RefreshCw className="h-4 w-4" aria-hidden />}
            >
              {loading ? t("platform.tenants.refreshing") : t("platform.tenants.refresh")}
            </Button>
          </>
        }
      />

      {notice && (
        <div role="status" className="flex items-start gap-3">
          <Callout tone="ok" className="flex-1" title={t("platform.tenants.lifecycleUpdated")}>
            {notice}
          </Callout>
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)} aria-label={t("platform.tenants.dismiss")} icon={<X className="h-4 w-4" />}>
            {""}
          </Button>
        </div>
      )}

      {error && (
        <ErrorState title={t("platform.tenants.unavailable")} message={error} retry={handleRefresh} />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title={t("platform.tenants.directory")}
          subtitle={t("platform.tenants.directorySubtitle", { shown: tc("platform.tenants.tenant", filtered.length, { count: formatNumber(filtered.length) }), active: formatNumber(activeCount), suspended: formatNumber(suspendedCount) })}
          actions={
            <div className="relative w-full sm:w-[280px]">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("platform.tenants.searchPlaceholder")}
                aria-label={t("platform.tenants.searchLabel")}
                className="ps-9"
              />
            </div>
          }
        />

        {loading && tenants.length === 0 ? (
          <TableSkeleton rows={6} columns={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-5 w-5" />}
            title={tenants.length === 0 ? t("platform.tenants.emptyTitle") : t("platform.tenants.noMatchesTitle")}
            description={
              tenants.length === 0
                ? t("platform.tenants.emptyBody")
                : t("platform.tenants.noMatchesBody")
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[920px]">
              <caption className="sr-only">{t("platform.tenants.tableCaption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("platform.tenants.colTenant")}</th>
                  <th scope="col">{t("platform.tenants.colStatus")}</th>
                  <th scope="col">{t("platform.tenants.colPlan")}</th>
                  <th scope="col" className="text-end">{t("platform.tenants.colMembers")}</th>
                  <th scope="col">{t("platform.tenants.colFleet")}</th>
                  <th scope="col" className="text-end">{t("platform.tenants.colCreated")}</th>
                  <th scope="col" className="w-[1%] text-end">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tenant) => {
                  const meta = LIFECYCLE_META[tenant.lifecycle];
                  const items = tenantMenu(tenant);
                  return (
                    <tr key={tenant.id}>
                      <td>
                        <div className="text-sm font-[550] text-ink">{tenant.name}</div>
                        <div className="mt-0.5 font-mono text-2xs text-ink-4">{tenant.id}</div>
                      </td>
                      <td>
                        <div className="max-w-[220px]">
                          <StatusBadge tone={meta.tone} label={t(meta.key)} size="sm" />
                          {tenant.lifecycleReason && (
                            <div className="mt-1 truncate text-xs text-ink-3" title={tenant.lifecycleReason}>
                              {tenant.lifecycleReason}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="text-sm text-ink-2">{tenant.planName || t("platform.tenants.noPlan")}</td>
                      <td className="text-end text-sm tabular text-ink-2">{formatNumber(tenant.memberCount)}</td>
                      <td className="text-xs text-ink-3">
                        <div>{tc("platform.tenants.agentsCount", tenant.agentCount, { count: formatNumber(tenant.agentCount) })}</div>
                        <div>{tc("platform.tenants.printersCount", tenant.printerCount, { count: formatNumber(tenant.printerCount) })}</div>
                      </td>
                      <td className="text-end text-sm text-ink-3">
                        {formatDate(tenant.createdAt)}
                      </td>
                      <td className="text-end">
                        {items.length === 0 ? (
                          <span className="text-xs text-ink-4">{t("platform.tenants.noActions")}</span>
                        ) : (
                          <Menu
                            label={t("platform.tenants.actionsFor", { name: tenant.name })}
                            items={items}
                            trigger={
                              <span className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink-3 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink">
                                <MoreHorizontal className="h-4 w-4" aria-hidden />
                              </span>
                            }
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={selectedTenant !== null}
        onClose={closeDialog}
        title={dialogMode === "suspend" ? t("platform.tenants.suspendTitle") : t("platform.tenants.reactivateTitle")}
        description={dialogMode === "suspend" ? t("platform.tenants.suspendDescription") : t("platform.tenants.reactivateDescription")}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={actionLoading}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={dialogMode === "suspend" ? "danger" : "primary"}
              onClick={() => void handleLifecycleAction()}
              disabled={actionLoading || (dialogMode === "suspend" && !suspendReason.trim())}
              loading={actionLoading}
            >
              {dialogMode === "suspend" ? t("platform.tenants.suspendTitle") : t("platform.tenants.reactivateTitle")}
            </Button>
          </>
        }
      >
        {selectedTenant && (
          <div className="space-y-4">
            <div className="rounded-sg border border-edge bg-surface-2 px-4 py-3">
              <div className="text-sm font-[600] text-ink">{selectedTenant.name}</div>
              <div className="mt-1 font-mono text-2xs text-ink-3">{selectedTenant.id}</div>
            </div>

            {dialogMode === "suspend" ? (
              <>
                <Callout tone="warn" title={t("platform.tenants.whatSuspensionDoes")} icon={<Ban className="h-4 w-4" />}>
                  {t("platform.tenants.whatSuspensionBody")}
                </Callout>
                <Field
                  label={t("platform.tenants.reasonLabel")}
                  htmlFor="suspension-reason"
                  hint={t("platform.tenants.reasonHint")}
                  required
                >
                  <Textarea
                    id="suspension-reason"
                    value={suspendReason}
                    onChange={(e) => setSuspendReason(e.target.value.slice(0, 500))}
                    placeholder={t("platform.tenants.reasonPlaceholder")}
                    rows={4}
                    autoFocus
                    disabled={actionLoading}
                    maxLength={500}
                  />
                </Field>
                <div className="text-end text-xs text-ink-3 tabular">{formatNumber(suspendReason.length)}/500</div>
              </>
            ) : (
              <Callout tone="ok" title={t("platform.tenants.accessResumes")}>
                {t("platform.tenants.accessResumesBody")}
              </Callout>
            )}

            {actionError && (
              <ErrorState title={t("platform.tenants.actionFailed")} message={actionError} />
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
