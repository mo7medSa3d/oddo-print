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

const LIFECYCLE_META: Record<Tenant["lifecycle"], { tone: Tone; label: string }> = {
  active: { tone: "ok", label: "Active" },
  suspended: { tone: "warn", label: "Suspended" },
  deleted: { tone: "bad", label: "Deleted" },
};

export default function PlatformTenantsPage() {
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
        if (!res.ok) { const data = await res.json().catch(() => null); throw new Error(data?.error || "Failed to load tenants."); }
        const data = await res.json();
        if (!ignore) { setTenants(Array.isArray(data.tenants) ? data.tenants : []); setError(null); }
      } catch (err: unknown) {
        if (!ignore) setError(err instanceof Error ? err.message : "Failed to load tenants.");
      } finally { if (!ignore) setLoading(false); }
    }
    void load();
    return () => { ignore = true; };
  }, [reloadKey]);

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
    if (dialogMode === "suspend" && !reason) { setActionError("Enter a reason before suspending this tenant."); return; }
    setActionLoading(true); setActionError(null); setNotice(null);
    const nextLifecycle = dialogMode === "suspend" ? "suspended" : "active";
    try {
      const endpoint = dialogMode === "suspend" ? `/api/platform/tenants/${selectedTenant.id}/suspend` : `/api/platform/tenants/${selectedTenant.id}/reactivate`;
      const options: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" } };
      if (dialogMode === "suspend") options.body = JSON.stringify({ reason });
      const res = await fetch(endpoint, options);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "The tenant lifecycle action failed.");
      const actionLabel = nextLifecycle === "suspended" ? "suspended" : "reactivated";
      const tenantName = selectedTenant.name;
      setSelectedTenant(null); setSuspendReason(""); setActionError(null);
      setNotice(`Tenant "${tenantName}" was ${actionLabel} successfully.`);
      handleRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "The tenant lifecycle action failed.");
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
            label: "Suspend workspace…",
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
              label: "Reactivate workspace…",
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
        eyebrow="Control plane · Tenants"
        icon={<Building2 className="h-4 w-4" aria-hidden />}
        title="Tenants"
        description="Every workspace on the platform, with fleet size and lifecycle control."
        actions={
          <>
            {suspendedCount > 0 && <StatusBadge tone="warn" label={`${suspendedCount} suspended`} />}
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

      {notice && (
        <div role="status" className="flex items-start gap-3">
          <Callout tone="ok" className="flex-1" title="Lifecycle updated">
            {notice}
          </Callout>
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)} aria-label="Dismiss notification" icon={<X className="h-4 w-4" />}>
            {""}
          </Button>
        </div>
      )}

      {error && (
        <ErrorState title="Tenant directory unavailable" message={error} retry={handleRefresh} />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title="Workspace directory"
          subtitle={`${filtered.length} ${filtered.length === 1 ? "tenant" : "tenants"} · ${activeCount} active · ${suspendedCount} suspended`}
          actions={
            <div className="relative w-full sm:w-[280px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or ID…"
                aria-label="Search tenants"
                className="pl-9"
              />
            </div>
          }
        />

        {loading && tenants.length === 0 ? (
          <TableSkeleton rows={6} columns={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-5 w-5" />}
            title={tenants.length === 0 ? "No tenants yet" : "No tenants match this search"}
            description={
              tenants.length === 0
                ? "Workspaces appear here as soon as customers complete signup."
                : "Try a different tenant name or identifier."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[920px]">
              <caption className="sr-only">Platform tenants</caption>
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Status</th>
                  <th scope="col">Plan</th>
                  <th scope="col" className="text-right">Members</th>
                  <th scope="col">Fleet</th>
                  <th scope="col" className="text-right">Created</th>
                  <th scope="col" className="w-[1%] text-right">Actions</th>
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
                          <StatusBadge tone={meta.tone} label={meta.label} size="sm" />
                          {tenant.lifecycleReason && (
                            <div className="mt-1 truncate text-xs text-ink-3" title={tenant.lifecycleReason}>
                              {tenant.lifecycleReason}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="text-sm text-ink-2">{tenant.planName || "No plan"}</td>
                      <td className="text-right text-sm tabular text-ink-2">{tenant.memberCount}</td>
                      <td className="text-xs text-ink-3">
                        <div>{tenant.agentCount} agents</div>
                        <div>{tenant.printerCount} printers</div>
                      </td>
                      <td className="text-right text-sm text-ink-3">
                        {new Date(tenant.createdAt).toLocaleDateString()}
                      </td>
                      <td className="text-right">
                        {items.length === 0 ? (
                          <span className="text-xs text-ink-4">No actions</span>
                        ) : (
                          <Menu
                            label={`Actions for ${tenant.name}`}
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
        title={dialogMode === "suspend" ? "Suspend tenant" : "Reactivate tenant"}
        description={dialogMode === "suspend" ? "Pause the workspace until it is reactivated." : "Restore the workspace to active."}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={actionLoading}>
              Cancel
            </Button>
            <Button
              variant={dialogMode === "suspend" ? "danger" : "primary"}
              onClick={() => void handleLifecycleAction()}
              disabled={actionLoading || (dialogMode === "suspend" && !suspendReason.trim())}
              loading={actionLoading}
            >
              {dialogMode === "suspend" ? "Suspend tenant" : "Reactivate tenant"}
            </Button>
          </>
        }
      >
        {selectedTenant && (
          <div className="space-y-4">
            <div className="rounded-lg border border-edge bg-surface-2 px-4 py-3">
              <div className="text-sm font-[600] text-ink">{selectedTenant.name}</div>
              <div className="mt-1 font-mono text-2xs text-ink-3">{selectedTenant.id}</div>
            </div>

            {dialogMode === "suspend" ? (
              <>
                <Callout tone="warn" title="What suspension does" icon={<Ban className="h-4 w-4" />}>
                  Members lose their sessions, agents stop syncing and new print operations are
                  blocked until the workspace is reactivated.
                </Callout>
                <Field
                  label="Suspension reason"
                  htmlFor="suspension-reason"
                  hint="Recorded in the audit stream for compliance."
                  required
                >
                  <Textarea
                    id="suspension-reason"
                    value={suspendReason}
                    onChange={(e) => setSuspendReason(e.target.value.slice(0, 500))}
                    placeholder="e.g. Billing overdue, security review…"
                    rows={4}
                    autoFocus
                    disabled={actionLoading}
                    maxLength={500}
                  />
                </Field>
                <div className="text-right text-xs text-ink-3 tabular">{suspendReason.length}/500</div>
              </>
            ) : (
              <Callout tone="ok" title="Access resumes immediately">
                Active sessions and print operations can continue after this action.
              </Callout>
            )}

            {actionError && (
              <ErrorState title="Action failed" message={actionError} />
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
