"use client";
import Link from "next/link";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import { fetchWithTimeout } from "../../../lib/fetch-timeout";

type Tenant = {
  id: string;
  name: string;
  lifecycle: "active" | "suspended" | "deleted";
  lifecycleReason: string | null;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
  subscriptionStatus: string | null;
  planName: string | null;
  memberCount: number;
  agentCount: number;
  printerCount: number;
};

type DialogMode = "suspend" | "reactivate" | "delete";

const LIFECYCLE_META: Record<Tenant["lifecycle"], { tone: Tone; key: MessageKey }> = {
  active: { tone: "ok", key: "platform.tenants.lifecycle.active" },
  suspended: { tone: "warn", key: "platform.tenants.lifecycle.suspended" },
  deleted: { tone: "bad", key: "platform.tenants.lifecycle.deleted" },
};

export default function PlatformTenantsPage() {
  const { t, tc, locale, formatNumber, formatDate } = useI18n();
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [completedQuery, setCompletedQuery] = useState<string | null>(null);
  const [search, setSearchValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode>("suspend");
  const [suspendReason, setSuspendReason] = useState("");
  
  const [operationKey,setOperationKey] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const queryKey = JSON.stringify([offset, search, reloadKey, locale]);
  const loading = completedQuery !== queryKey;
  function setSearch(value: string) { setSearchValue(value); setOffset(0); }


  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetchWithTimeout(
          `/api/platform/tenants?limit=100&offset=${offset}&search=${encodeURIComponent(search.trim())}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (ignore) return;
        if (res.status === 401) router.replace("/platform/login?next=%2Fplatform%2Ftenants");
        if (!res.ok) throw new Error(t("platform.tenants.loadFailed"));
        const data = await res.json();
        if (!ignore) { setTenants(Array.isArray(data.tenants) ? data.tenants : []); setHasMore(data.hasMore === true); setError(null); }
      } catch {
        if (!ignore) {
          // A failed refresh must not leave stale workspace lifecycle actions
          // available against a potentially changed control-plane state.
          setTenants([]);
          setHasMore(false);
          setSelectedTenant(null);
          setError(t("platform.tenants.loadFailed"));
        }
      } finally { if (!ignore) setCompletedQuery(queryKey); }
    }
    void load();
    return () => { ignore = true; controller.abort(); };
  }, [reloadKey, t, offset, search, queryKey, router]);

  function closeDialog() {
    if (actionLoading) return;
    setSelectedTenant(null);
    setSuspendReason("");
    
    setActionError(null);
  }

  function handleRefresh() { setError(null); setReloadKey((k) => k + 1); }
  function openSuspend(tenant: Tenant) { setOperationKey(crypto.randomUUID()); setSelectedTenant(tenant); setDialogMode("suspend"); setSuspendReason(""); setActionError(null); }
  function openReactivate(tenant: Tenant) { setOperationKey(crypto.randomUUID()); setSelectedTenant(tenant); setDialogMode("reactivate"); setSuspendReason(""); setActionError(null); }
  function openDelete(tenant: Tenant) { setOperationKey(crypto.randomUUID()); setSelectedTenant(tenant); setDialogMode("delete"); setSuspendReason("");  setActionError(null); }

  async function handleLifecycleAction() {
    if (!selectedTenant) return;
    const reason = suspendReason.trim();


    setActionLoading(true); setActionError(null); setNotice(null);
    const nextLifecycle = dialogMode === "suspend" ? "suspended" : dialogMode === "delete" ? "deleted" : "active";
    try {
      const endpoint = `/api/platform/tenants/${encodeURIComponent(selectedTenant.id)}/${dialogMode === "delete" ? "delete" : dialogMode === "suspend" ? "suspend" : "reactivate"}`;
      const options: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" } };
      if(dialogMode !== "delete") options.headers = { "Content-Type":"application/json", "Idempotency-Key":operationKey };
      options.body = JSON.stringify(dialogMode === "delete" ? {reason,confirmed:true} : {reason:reason||t(dialogMode==='reactivate'?"v4.admin.reactivateWorkspace":"v4.admin.suspendWorkspace"),expectedLifecycle:selectedTenant.lifecycle,expectedUpdatedAt:selectedTenant.updatedAt});
      const res = await fetchWithTimeout(endpoint, options);
      if (!res.ok) throw new Error(t("platform.tenants.actionFailedBody"));
      const confirmation = await res.json().catch(() => null) as {ok?: boolean; tenantId?: string; lifecycle?: string} | null;
      // A replay can return 200 even if a later operator has since changed
      // the workspace again. Never report the requested state without proof.
      if (confirmation?.ok !== true || confirmation.tenantId !== selectedTenant.id ||
          confirmation.lifecycle !== nextLifecycle) {
        handleRefresh();
        throw new Error(t("platform.tenants.actionFailedBody"));
      }
      const tenantName = selectedTenant.name;
      setSelectedTenant(null); setSuspendReason("");  setActionError(null);
      setNotice(
        nextLifecycle === "suspended"
          ? t("platform.tenants.noticeSuspended", { name: tenantName })
          : nextLifecycle === "deleted" ? t("platform.tenants.noticeDeleted", { name: tenantName })
          : t("platform.tenants.noticeReactivated", { name: tenantName }),
      );
      handleRefresh();
    } catch {
      // Network timeouts cannot prove whether a destructive action committed.
      // Use the localized uncertainty guidance, never a raw fetch error.
      setActionError(t("platform.tenants.actionFailedBody"));
      handleRefresh();
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
          { key: "delete", label: t("platform.tenants.deleteTitle"), icon: <AlertOctagon className="h-4 w-4" />, tone: "danger", disabled: actionLoading, onSelect: () => openDelete(tenant) },
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
            { key: "delete", label: t("platform.tenants.deleteTitle"), icon: <AlertOctagon className="h-4 w-4" />, tone: "danger", disabled: actionLoading, onSelect: () => openDelete(tenant) },
          ]
        : [];

  return (
    <div className="space-y-5">
      <PageHeader
        variant="inline"
        icon={<Building2 className="h-4 w-4" aria-hidden />}
        title={t("platform.tenants.title")} 
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
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)} aria-label={t("platform.tenants.dismiss")} icon={<X className="h-4 w-4" />} />
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
          <>
          {/* On phones a 920px spreadsheet makes status and actions hard to
              find. Keep the same authoritative rows in a semantic card list. */}
          <ul className="divide-y divide-edge-subtle lg:hidden" aria-label={t("platform.tenants.tableCaption")}>
            {filtered.map((tenant) => {
              const meta = LIFECYCLE_META[tenant.lifecycle];
              const items = tenantMenu(tenant);
              return (
                <li key={tenant.id} className="min-w-0 px-4 py-4 sm:px-5 sm:py-5">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="break-words text-base font-[650] leading-snug text-ink">{<Link className="rounded-sm underline decoration-brand/40 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35" href={`/platform/tenants/${encodeURIComponent(tenant.id)}`}>{tenant.name}</Link>}</h3>
                      <div dir="ltr" className="mt-1 break-all font-mono text-xs text-ink-4 [unicode-bidi:plaintext]">{tenant.id}</div>
                    </div>
                    {items.length > 0 && (
                      <Menu
                        label={t("platform.tenants.actionsFor", { name: tenant.name })}
                        items={items}
                        placement="below"
                        trigger={
                          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-edge bg-surface text-ink-2 transition-colors hover:bg-surface-2">
                            <MoreHorizontal className="h-5 w-5" aria-hidden />
                          </span>
                        }
                      />
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <StatusBadge tone={meta.tone} label={t(meta.key)} size="sm" />
                    <span className="rounded-sm bg-surface-2 px-2 py-1 text-xs text-ink-2">
                      {tenant.planName || t("platform.tenants.noPlan")}
                    </span>
                  </div>
                  {tenant.lifecycleReason && (
                    <p className="mt-2 break-words text-xs leading-relaxed text-ink-3">{tenant.lifecycleReason}</p>
                  )}
                  <dl className="mt-4 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 rounded-md border border-edge-subtle bg-surface-2/60 p-3 sm:grid-cols-3">
                    <div className="min-w-0">
                      <dt className="text-xs text-ink-3">{t("platform.tenants.colMembers")}</dt>
                      <dd className="mt-1 text-sm font-semibold tabular-nums text-ink">{formatNumber(tenant.memberCount)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-ink-3">{t("platform.tenants.colFleet")}</dt>
                      <dd className="mt-1 space-y-0.5 text-xs leading-relaxed text-ink-2">
                        <span className="block">{tc("platform.tenants.agentsCount", tenant.agentCount, { count: formatNumber(tenant.agentCount) })}</span>
                        <span className="block">{tc("platform.tenants.printersCount", tenant.printerCount, { count: formatNumber(tenant.printerCount) })}</span>
                      </dd>
                    </div>
                    <div className="col-span-2 min-w-0 sm:col-span-1">
                      <dt className="text-xs text-ink-3">{t("platform.tenants.colCreated")}</dt>
                      <dd className="mt-1 text-sm font-medium tabular-nums text-ink-2">{formatDate(tenant.createdAt)}</dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
          <div className="hidden min-w-0 overflow-x-auto overscroll-x-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand lg:block"
               role="region" aria-label={t("platform.tenants.tableCaption")} aria-busy={loading || undefined} tabIndex={0}>
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
                        <div className="text-sm font-[550] text-ink">{<Link className="rounded-sm underline decoration-brand/40 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35" href={`/platform/tenants/${encodeURIComponent(tenant.id)}`}>{tenant.name}</Link>}</div>
                        <div dir="ltr" className="mt-0.5 font-mono text-xs text-ink-4 [unicode-bidi:plaintext]">{tenant.id}</div>
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
                      <td className="text-end text-sm tabular-nums text-ink-3">
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
                              <span className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2">
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
          </>
        )}
      </Card>

      <Modal
        open={selectedTenant !== null}
        onClose={closeDialog}
        title={dialogMode === "delete" ? t("platform.tenants.deleteTitle") : dialogMode === "suspend" ? t("platform.tenants.suspendTitle") : t("platform.tenants.reactivateTitle")}
        description={dialogMode === "delete" ? t("platform.tenants.deleteDescription") : dialogMode === "suspend" ? t("platform.tenants.suspendDescription") : t("platform.tenants.reactivateDescription")}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={actionLoading}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={dialogMode !== "reactivate" ? "danger" : "primary"}
              onClick={() => void handleLifecycleAction()}
              disabled={actionLoading}
              loading={actionLoading}
            >
              {dialogMode === "delete" ? t("platform.tenants.deleteConfirm") : dialogMode === "suspend" ? t("platform.tenants.suspendTitle") : t("platform.tenants.reactivateTitle")}
            </Button>
          </>
        }
      >
        {selectedTenant && (
          <div className="space-y-4">
            <div className="rounded-md border border-edge bg-surface-2 px-4 py-3">
              <div className="text-sm font-[600] text-ink">{selectedTenant.name}</div>
              <div dir="ltr" className="mt-1 font-mono text-xs text-ink-3 [unicode-bidi:plaintext]">{selectedTenant.id}</div>
            </div>

            {dialogMode !== "reactivate" ? (
              <>
                <Callout tone="warn" title={t("platform.tenants.whatSuspensionDoes")} icon={<Ban className="h-4 w-4" />}>
                  {t("platform.tenants.whatSuspensionBody")}
                </Callout>
                <Field
                  label={t("platform.tenants.reasonLabel")}
                  htmlFor="suspension-reason"
                  hint={t("platform.tenants.reasonOptionalHint")}
                >
                  <Textarea
                    id="suspension-reason"
                    value={suspendReason}
                    onChange={(e) => setSuspendReason(e.target.value.slice(0, 500))}
                    placeholder={t("platform.tenants.reasonPlaceholder")}
                    rows={4}
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
      <div className="flex items-center justify-between gap-3">
        <span aria-live="polite" className="text-sm tabular-nums text-ink-3">{tenants.length === 0 ? t("common.pageEmpty") : t("common.pageRange", { start: formatNumber(offset + 1), end: formatNumber(offset + tenants.length) })}</span>
        <div className="flex gap-2">
          <Button disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 100))}>{t("common.previousPage")}</Button>
          <Button disabled={loading || !hasMore} onClick={() => setOffset(value => value + 100)}>{t("common.nextPage")}</Button>
        </div>
      </div>
    </div>
  );
}
