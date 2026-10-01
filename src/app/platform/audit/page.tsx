"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Shield, Search, RefreshCw, ChevronDown, ScrollText } from "lucide-react";
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

type ActorType = "platform" | "user" | "system" | "agent" | "odoo" | "desktop";

type AuditEvent = {
  id: string;
  tenantId: string | null;
  tenantName: string | null;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

const ACTOR_TONE: Record<ActorType, Tone> = {
  platform: "brand",
  user: "info",
  system: "neutral",
  agent: "ok",
  odoo: "warn",
  desktop: "neutral",
};

type Filter = "all" | "platform" | "tenant" | "machine";

export default function PlatformAuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/platform/audit?limit=150");
        if (ignore) return;
        if (!res.ok) throw new Error("Failed to fetch audit feed");
        const data = await res.json();
        if (!ignore) { setEvents(data.auditEvents || []); setError(null); }
      } catch (err: unknown) { if (!ignore) setError(err instanceof Error ? err.message : "Error loading audit logs"); }
      finally { if (!ignore) setLoading(false); }
    }
    load();
    return () => { ignore = true; };
  }, [reloadKey]);

  function handleRefresh() { setLoading(true); setReloadKey((k) => k + 1); }

  const counts = useMemo(
    () => ({
      all: events.length,
      platform: events.filter((e) => e.actorType === "platform" || e.actorType === "user").length,
      tenant: events.filter((e) => e.actorType === "system" || e.actorType === "odoo").length,
      machine: events.filter((e) => e.actorType === "agent" || e.actorType === "desktop").length,
    }),
    [events],
  );

  const filtered = events.filter((e) => {
    const term = search.trim().toLowerCase();
    const matchesSearch =
      term.length === 0 ||
      e.action.toLowerCase().includes(term) ||
      (e.tenantId ? e.tenantId.toLowerCase().includes(term) : false) ||
      (e.tenantName ? e.tenantName.toLowerCase().includes(term) : false) ||
      (e.actorId ? e.actorId.toLowerCase().includes(term) : false);
    const matchesFilter =
      filter === "all"
        ? true
        : filter === "platform"
          ? e.actorType === "platform" || e.actorType === "user"
          : filter === "tenant"
            ? e.actorType === "system" || e.actorType === "odoo"
            : e.actorType === "agent" || e.actorType === "desktop";
    return matchesSearch && matchesFilter;
  });

  return (
    <div className="space-y-5">
      <PageHeader
        variant="inline"
        eyebrow="Compliance · Append-only"
        icon={<Shield className="h-4 w-4" aria-hidden />}
        title="Audit stream"
        description="Every privileged action taken by platform staff, tenants, agents and integrations."
        actions={
          <Button
            variant="secondary"
            onClick={handleRefresh}
            disabled={loading}
            loading={loading}
            icon={loading ? undefined : <RefreshCw className="h-4 w-4" aria-hidden />}
          >
            {loading ? "Refreshing…" : "Refresh stream"}
          </Button>
        }
      />

      {error && (
        <ErrorState title="Audit feed unavailable" message={error} retry={handleRefresh} />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title="Events"
          subtitle={`${filtered.length} of ${events.length} loaded`}
          icon={<ScrollText className="h-4 w-4" />}
          actions={
            <SegmentedControl
              label="Filter by actor"
              value={filter}
              onChange={setFilter}
              size="sm"
              options={[
                { value: "all", label: `All (${counts.all})` },
                { value: "platform", label: `Staff (${counts.platform})` },
                { value: "tenant", label: `Tenant (${counts.tenant})` },
                { value: "machine", label: `Machine (${counts.machine})` },
              ]}
            />
          }
        />

        <div className="border-b border-edge-subtle px-5 py-3">
          <div className="relative max-w-lg">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by action, tenant or actor ID…"
              aria-label="Filter audit events"
              className="pl-9"
            />
          </div>
        </div>

        {loading && events.length === 0 ? (
          <TableSkeleton rows={8} columns={4} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="h-5 w-5" />}
            title={events.length === 0 ? "No audit events yet" : "No matching events"}
            description={
              events.length === 0
                ? "Privileged actions are recorded here as they happen. Nothing to show so far."
                : "Adjust the search term or switch the actor filter to see more results."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[900px]">
              <caption className="sr-only">Platform audit events</caption>
              <thead>
                <tr>
                  <th scope="col">Timestamp</th>
                  <th scope="col">Action</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Resource</th>
                  <th scope="col" className="w-[1%]" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const open = expanded === e.id;
                  const hasMetadata = e.metadata && Object.keys(e.metadata).length > 0;
                  return (
                    <Fragment key={e.id}>
                      <tr>
                        <td className="whitespace-nowrap font-mono text-2xs tabular text-ink-3">
                          {new Date(e.createdAt).toLocaleString()}
                        </td>
                        <td>
                          <span className="font-mono text-xs font-[600] text-ink">{e.action}</span>
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <StatusBadge tone={ACTOR_TONE[e.actorType] ?? "neutral"} label={e.actorType} size="sm" />
                            <span className="max-w-[160px] truncate font-mono text-2xs text-ink-3" title={e.actorId ?? undefined}>
                              {e.actorId || "—"}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="text-sm font-[550] text-ink">{e.tenantName || e.tenantId || "Platform"}</div>
                          <div className="mt-0.5 font-mono text-2xs text-ink-4">{e.tenantId ?? "—"}</div>
                        </td>
                        <td className="text-2xs text-ink-4">
                          {e.resourceType ? `${e.resourceType}: ${e.resourceId ?? "—"}` : "—"}
                        </td>
                        <td className="text-right">
                          {hasMetadata && (
                            <button
                              type="button"
                              onClick={() => setExpanded(open ? null : e.id)}
                              aria-expanded={open}
                              aria-label={open ? "Hide event metadata" : "Show event metadata"}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-ink-4 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink"
                            >
                              <ChevronDown className={`h-4 w-4 transition-transform duration-[160ms] ${open ? "rotate-180" : ""}`} aria-hidden />
                            </button>
                          )}
                        </td>
                      </tr>
                      {open && hasMetadata && (
                        <tr>
                          <td colSpan={6} className="bg-surface-2">
                            <pre className="max-h-52 overflow-auto font-mono text-2xs leading-relaxed text-ink-2">
                              {JSON.stringify(e.metadata, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
