"use client";

import { fetchWithTimeout } from "../../../lib/fetch-timeout";
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
import { useI18n } from "../../../i18n/react";
import type { Translator } from "../../../i18n/translate";
import type { MessageKey } from "../../../i18n/messages/en";

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

const ACTOR_LABEL_KEYS: Record<ActorType, MessageKey> = {
  platform: "platform.audit.actor.platform",
  user: "platform.audit.actor.user",
  system: "platform.audit.actor.system",
  agent: "platform.audit.actor.agent",
  odoo: "platform.audit.actor.odoo",
  desktop: "platform.audit.actor.desktop",
};

/** Actor types arrive from the API as enums; render them through the catalog. */
function actorLabel(actor: ActorType, t: Translator): string {
  return t(ACTOR_LABEL_KEYS[actor] ?? "platform.audit.actor.system");
}

type Filter = "all" | "platform" | "tenant" | "machine";

export default function PlatformAuditPage() {
  const { t, formatNumber, formatDateTime } = useI18n();
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
        const res = await fetchWithTimeout("/api/platform/audit?limit=150");
        if (ignore) return;
        if (!res.ok) throw new Error(t("platform.audit.loadFailed"));
        const data = await res.json();
        if (!ignore) { setEvents(data.auditEvents || []); setError(null); }
      } catch { if (!ignore) setError(t("platform.audit.loadError")); }
      finally { if (!ignore) setLoading(false); }
    }
    load();
    return () => { ignore = true; };
  }, [reloadKey, t]);

  function handleRefresh() { setLoading(true); setReloadKey((k) => k + 1); }

  // Actor scope, not actor kind, decides the bucket: a `user` row carrying a
  // tenantId is tenant-scoped activity, not platform staff. Only platform
  // actors (or users without tenant scope) count as staff (C061).
  const inStaff = (tenantId: string | null, actorType: ActorType) =>
    actorType === "platform" || (actorType === "user" && !tenantId);
  const inTenant = (tenantId: string | null, actorType: ActorType) =>
    !!tenantId || actorType === "system" || actorType === "odoo";
  const inMachine = (actorType: ActorType) => actorType === "agent" || actorType === "desktop";

  const counts = useMemo(
    () => ({
      all: events.length,
      platform: events.filter((e) => inStaff(e.tenantId, e.actorType)).length,
      tenant: events.filter((e) => inTenant(e.tenantId, e.actorType)).length,
      machine: events.filter((e) => inMachine(e.actorType)).length,
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
          ? inStaff(e.tenantId, e.actorType)
          : filter === "tenant"
            ? inTenant(e.tenantId, e.actorType)
            : inMachine(e.actorType);
    return matchesSearch && matchesFilter;
  });

  return (
    <div className="space-y-5">
      <PageHeader
        variant="inline"
        icon={<Shield className="h-4 w-4" aria-hidden />}
        title={t("platform.audit.title")}
        description={t("platform.audit.description")}
        actions={
          <Button
            variant="secondary"
            onClick={handleRefresh}
            disabled={loading}
            loading={loading}
            icon={loading ? undefined : <RefreshCw className="h-4 w-4" aria-hidden />}
          >
            {loading ? t("platform.audit.refreshing") : t("platform.audit.refresh")}
          </Button>
        }
      />

      {error && (
        <ErrorState title={t("platform.audit.unavailable")} message={error} retry={handleRefresh} />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title={t("platform.audit.events")}
          subtitle={t("platform.audit.shown", { filtered: formatNumber(filtered.length), total: formatNumber(events.length) })}
          icon={<ScrollText className="h-4 w-4" />}
          actions={
            <SegmentedControl
              label={t("platform.audit.filterLabel")}
              value={filter}
              onChange={setFilter}
              size="sm"
              options={[
                { value: "all", label: t("platform.audit.filter.all", { count: formatNumber(counts.all) }) },
                { value: "platform", label: t("platform.audit.filter.staff", { count: formatNumber(counts.platform) }) },
                { value: "tenant", label: t("platform.audit.filter.tenant", { count: formatNumber(counts.tenant) }) },
                { value: "machine", label: t("platform.audit.filter.machine", { count: formatNumber(counts.machine) }) },
              ]}
            />
          }
        />

        <div className="border-b border-edge-subtle px-5 py-3">
          <div className="relative max-w-lg">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("platform.audit.searchPlaceholder")}
              aria-label={t("platform.audit.searchLabel")}
              className="ps-9"
            />
          </div>
        </div>

        {loading && events.length === 0 ? (
          <TableSkeleton rows={8} columns={4} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="h-5 w-5" />}
            title={events.length === 0 ? t("platform.audit.emptyTitle") : t("platform.audit.noMatchesTitle")}
            description={
              events.length === 0
                ? t("platform.audit.emptyBody")
                : t("platform.audit.noMatchesBody")
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[900px]">
              <caption className="sr-only">{t("platform.audit.tableCaption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("platform.audit.timestamp")}</th>
                  <th scope="col">{t("platform.audit.action")}</th>
                  <th scope="col">{t("platform.audit.actor")}</th>
                  <th scope="col">{t("platform.audit.tenant")}</th>
                  <th scope="col">{t("platform.audit.resource")}</th>
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
                        <td dir="ltr" className="whitespace-nowrap font-mono text-xs tabular text-ink-3 [unicode-bidi:plaintext]">
                          {formatDateTime(e.createdAt)}
                        </td>
                        <td>
                          <span className="font-mono text-xs font-[600] text-ink">{e.action}</span>
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <StatusBadge tone={ACTOR_TONE[e.actorType] ?? "neutral"} label={actorLabel(e.actorType, t)} size="sm" />
                            <span dir="ltr" className="max-w-[180px] truncate font-mono text-xs text-ink-3 [unicode-bidi:plaintext]" title={e.actorId ?? undefined}>
                              {e.actorId || "—"}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="text-sm font-[550] text-ink">{e.tenantName || e.tenantId || t("platform.audit.platformScope")}</div>
                          <div dir="ltr" className="mt-0.5 font-mono text-xs text-ink-4 [unicode-bidi:plaintext]">{e.tenantId ?? "—"}</div>
                        </td>
                        <td dir="ltr" className="font-mono text-xs text-ink-4 [unicode-bidi:plaintext]">
                          {e.resourceType ? `${e.resourceType}: ${e.resourceId ?? "—"}` : "—"}
                        </td>
                        <td className="text-end">
                          {hasMetadata && (
                            <button
                              type="button"
                              onClick={() => setExpanded(open ? null : e.id)}
                              aria-expanded={open}
                              aria-label={open ? t("platform.audit.hideMetadata") : t("platform.audit.showMetadata")}
                              className="inline-flex h-9 w-9 items-center justify-center rounded-sm border border-edge bg-surface text-ink-3 transition-colors duration-150 hover:border-edge-strong hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                            >
                              <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden />
                            </button>
                          )}
                        </td>
                      </tr>
                      {open && hasMetadata && (
                        <tr>
                          <td colSpan={6} className="bg-surface-2">
                            <pre dir="ltr" className="max-h-56 overflow-auto rounded-sm bg-app p-3 font-mono text-xs leading-relaxed text-ink-2 [unicode-bidi:plaintext]">
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
