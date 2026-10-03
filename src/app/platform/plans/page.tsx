"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardHeader,
  ConfirmDialog,
  DataTableShell,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Select,
  StatusBadge,
  TableScroll,
  TableSkeleton,
  Textarea,
} from "../../../components/ui";
import { useI18n } from "../../../i18n/react";
import type { MessageKey } from "../../../i18n/messages/en";

type EntitlementKey = "max_agents" | "max_printers" | "max_jobs_per_minute" | "max_concurrent_jobs" | "max_prints_per_period";
type Entitlements = Record<EntitlementKey, number | "unlimited">;

type Plan = {
  id: string;
  name: string;
  description: string;
  entitlements: Entitlements;
  stripePriceId: string | null;
  stripeProductId: string | null;
  currency: string | null;
  interval: string | null;
  isActive: boolean;
  isPublic: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  subscriberCount: number;
  activeSubscriberCount: number;
};

const EMPTY_ENTITLEMENTS: Entitlements = { max_agents: 1, max_printers: 1, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: "unlimited" };
const ENTITLEMENT_LABEL_KEYS: Record<EntitlementKey, MessageKey> = {
  max_agents: "platform.plans.entitlement.agents",
  max_printers: "platform.plans.entitlement.printers",
  max_jobs_per_minute: "platform.plans.entitlement.jobsPerMinute",
  max_concurrent_jobs: "platform.plans.entitlement.concurrent",
  max_prints_per_period: "platform.plans.entitlement.prints",
};

function emptyForm() {
  return { id: "", name: "", description: "", stripePriceId: "", stripeProductId: "", currency: "usd", interval: "month", displayOrder: 0, isActive: true, isPublic: true, entitlements: { ...EMPTY_ENTITLEMENTS } };
}

export default function PlatformPlansPage() {
  const { t, tc, formatNumber } = useI18n();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<Plan | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/platform/plans", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (ignore) return;
        if (!res.ok) throw new Error(t("platform.plans.loadFailed"));
        setPlans(Array.isArray(data.plans) ? data.plans : []);
        setError(null);
      } catch { if (!ignore) setError(t("platform.plans.loadFailed")); }
      finally { if (!ignore) setLoading(false); }
    }
    void load();
    return () => { ignore = true; };
  }, [reloadKey, t]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return plans;
    return plans.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (p.stripePriceId ?? "").toLowerCase().includes(q));
  }, [plans, search]);

  function refresh(clearNotice = true) { setLoading(true); setError(null); if (clearNotice) setNotice(null); setReloadKey((k) => k + 1); }
  function openCreate() { setCreating(true); setEditing(null); setError(null); }
  function openEdit(plan: Plan) { setEditing(plan); setCreating(false); setError(null); }
  function closeEditor() { setCreating(false); setEditing(null); }

  async function archivePlan(plan: Plan) {
    setError(null); setNotice(null);
    setArchiveBusy(true);
    try {
      const res = await fetch(`/api/platform/plans/${plan.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: false }) });
      if (!res.ok) throw new Error(t("platform.plans.archiveFailed"));
      setNotice(t("platform.plans.archivedNotice", { name: plan.name }));
      setArchiving(null);
      refresh(false);
    } catch (err) { setError(err instanceof Error ? err.message : t("platform.plans.archiveFailed")); }
    finally { setArchiveBusy(false); }
  }

  async function save(form: ReturnType<typeof emptyForm>, isNew: boolean) {
    setError(null); setNotice(null);
    const url = isNew ? "/api/platform/plans" : `/api/platform/plans/${form.id}`;
    const payload = { id: form.id, name: form.name, description: form.description, stripePriceId: form.stripePriceId, stripeProductId: form.stripeProductId || undefined, currency: form.currency, interval: form.interval, displayOrder: form.displayOrder, isActive: form.isActive, isPublic: form.isPublic, entitlements: form.entitlements };
    try {
      const res = await fetch(url, { method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(t("platform.plans.saveFailed"));
      closeEditor();
      setNotice(isNew ? t("platform.plans.createdNotice", { name: form.name }) : t("platform.plans.updatedNotice", { name: form.name }));
      refresh(false);
    } catch (err) { setError(err instanceof Error ? err.message : t("platform.plans.saveFailed")); }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        variant="inline"
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            {t("platform.plans.eyebrow")}
          </span>
        }
        title={t("platform.plans.title")}
        description={t("platform.plans.description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => refresh()}
              disabled={loading}
              icon={<RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />}
            >
              {t("platform.plans.refresh")}
            </Button>
            <Button variant="primary" onClick={openCreate} icon={<Plus className="h-4 w-4" aria-hidden />}>
              {t("platform.plans.newPlan")}
            </Button>
          </div>
        }
      />

      {notice && (
        <Callout tone="ok" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />}>
          <span role="status">{notice}</span>
        </Callout>
      )}
      {error && !loading && (
        <ErrorState message={error} retry={() => refresh(false)} />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title={t("platform.plans.catalog")}
          subtitle={loading ? t("platform.plans.loadingCatalog") : tc("platform.plans.shown", plans.length, { filtered: formatNumber(filtered.length), total: formatNumber(plans.length) })}
          icon={<ShieldAlert className="h-4 w-4" aria-hidden />}
          actions={
            <div className="relative w-full sm:w-80">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("platform.plans.searchPlaceholder")}
                aria-label={t("platform.plans.searchLabel")}
                className="ps-9"
              />
            </div>
          }
        />

        {loading ? (
          <TableSkeleton rows={5} columns={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert className="h-5 w-5" aria-hidden />}
            title={plans.length === 0 ? t("platform.plans.emptyTitle") : t("platform.plans.noMatchesTitle")}
            description={
              plans.length === 0
                ? t("platform.plans.emptyBody")
                : t("platform.plans.noMatchesBody")
            }
            action={
              <Button variant="primary" onClick={openCreate} icon={<Plus className="h-4 w-4" aria-hidden />}>
                {t("platform.plans.newPlan")}
              </Button>
            }
          />
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <th scope="col">{t("platform.plans.colPlan")}</th>
                <th scope="col">{t("platform.plans.colVisibility")}</th>
                <th scope="col">{t("platform.plans.colLimits")}</th>
                <th scope="col">{t("platform.plans.colSubscribers")}</th>
                <th scope="col">{t("platform.plans.colStripePrice")}</th>
                <th scope="col" className="text-end">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((plan) => (
                <tr key={plan.id}>
                  <td>
                    <div className="text-base font-[600] text-ink">{plan.name}</div>
                    <Mono className="mt-0.5 block">{plan.id}</Mono>
                    {plan.description && (
                      <div className="mt-1 line-clamp-2 max-w-xs text-xs text-ink-4">{plan.description}</div>
                    )}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1.5">
                      {plan.isActive ? (
                        <StatusBadge size="sm" tone="ok" label={t("platform.plans.active")} />
                      ) : (
                        <StatusBadge size="sm" tone="neutral" label={t("platform.plans.archived")} icon={<Archive className="h-3 w-3" aria-hidden />} />
                      )}
                      <StatusBadge
                        size="sm"
                        tone={plan.isPublic ? "brand" : "neutral"}
                        label={plan.isPublic ? t("platform.plans.public") : t("platform.plans.private")}
                        icon={plan.isPublic ? <Eye className="h-3 w-3" aria-hidden /> : <EyeOff className="h-3 w-3" aria-hidden />}
                      />
                    </div>
                  </td>
                  <td>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      {(Object.entries(plan.entitlements) as Array<[EntitlementKey, number | "unlimited"]>).map(([k, v]) => (
                        <div key={k} className="flex items-baseline gap-1.5">
                          <dt className="text-ink-4">{t(ENTITLEMENT_LABEL_KEYS[k])}</dt>
                          <dd className="font-[550] tabular-nums text-ink">{v === "unlimited" ? t("platform.plans.unlimited") : formatNumber(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </td>
                  <td>
                    <div className="text-base font-[550] tabular-nums text-ink">{t("platform.plans.subscribersActive", { count: formatNumber(plan.activeSubscriberCount) })}</div>
                    <div className="mt-0.5 text-xs text-ink-4">{t("platform.plans.subscribersTotal", { count: formatNumber(plan.subscriberCount) })}</div>
                  </td>
                  <td>
                    <Mono className="block">{plan.stripePriceId || t("platform.plans.notLinked")}</Mono>
                    <div className="mt-0.5 text-xs text-ink-4">
                      {(plan.currency ?? "usd").toUpperCase()}
                      {plan.interval ? ` ${t("platform.plans.perInterval", { interval: plan.interval })}` : ""}
                    </div>
                  </td>
                  <td className="text-end">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openEdit(plan)}
                        icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
                      >
                        {t("platform.plans.edit")}
                      </Button>
                      {plan.isActive && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => { setArchiving(plan); setError(null); }}
                          icon={<Archive className="h-3.5 w-3.5" aria-hidden />}
                        >
                          {t("platform.plans.archive")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Card>

      {(creating || editing) && (
        <PlanEditor initial={editing ? { id: editing.id, name: editing.name, description: editing.description, stripePriceId: editing.stripePriceId || "", stripeProductId: editing.stripeProductId || "", currency: editing.currency || "usd", interval: editing.interval || "month", displayOrder: editing.displayOrder, isActive: editing.isActive, isPublic: editing.isPublic, entitlements: editing.entitlements } : emptyForm()} isNew={creating} onClose={closeEditor} onSave={save} />
      )}

      <ConfirmDialog
        open={archiving !== null}
        onClose={() => { if (!archiveBusy) setArchiving(null); }}
        onConfirm={() => { if (archiving) void archivePlan(archiving); }}
        busy={archiveBusy}
        tone="primary"
        title={archiving ? t("platform.plans.archiveConfirmTitle", { name: archiving.name }) : t("platform.plans.archiveTitle")}
        description={t("platform.plans.archiveDescription")}
        confirmLabel={t("platform.plans.archiveTitle")}
        cancelLabel={t("platform.plans.keepPlan")}
      >
        {archiving && (
          <div className="flex items-start gap-3 rounded-sg border border-edge bg-surface-2 p-3.5">
            <ArchiveRestore className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            <p className="text-sm leading-relaxed text-ink-2">
              <span className="font-[600] text-ink">{tc("platform.plans.archiveImpact", archiving.activeSubscriberCount, { count: formatNumber(archiving.activeSubscriberCount) })}</span>{" "}
              {t("platform.plans.archiveImpactTail")}{" "}
              <span className="font-[550] text-ink">{archiving.name}</span>{" "}
              {t("platform.plans.archiveImpactEnd")}
            </p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

function PlanEditor({ initial, isNew, onClose, onSave }: { initial: ReturnType<typeof emptyForm>; isNew: boolean; onClose: () => void; onSave: (form: ReturnType<typeof emptyForm>, isNew: boolean) => Promise<void>; }) {
  const { t } = useI18n();
  const entitlementLabel = (key: EntitlementKey) => t(ENTITLEMENT_LABEL_KEYS[key]);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function updateEntitlement(key: EntitlementKey, value: string) { setForm((c) => ({ ...c, entitlements: { ...c.entitlements, [key]: value.trim().toLowerCase() === "unlimited" ? "unlimited" : Number(value) } })); }

  async function submit() {
    setLocalError(null);
    if (isNew && !form.id.trim()) return setLocalError(t("platform.plans.validation.planId"));
    if (!form.name.trim()) return setLocalError(t("platform.plans.validation.name"));
    if (!/^price_[A-Za-z0-9_]+$/.test(form.stripePriceId.trim())) return setLocalError(t("platform.plans.validation.priceId"));
    for (const key of Object.keys(ENTITLEMENT_LABEL_KEYS) as EntitlementKey[]) { const v = form.entitlements[key]; if (v !== "unlimited" && (!Number.isSafeInteger(v) || v <= 0)) return setLocalError(t("platform.plans.validation.entitlement", { label: entitlementLabel(key) })); }
    setSaving(true);
    try { await onSave(form, isNew); } catch (err) { setLocalError(err instanceof Error ? err.message : t("platform.plans.saveFailed")); } finally { setSaving(false); }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title={isNew ? t("platform.plans.editor.createTitle") : t("platform.plans.editor.editTitle")}
      description={isNew ? t("platform.plans.editor.createDescription") : t("platform.plans.editor.editDescription", { name: form.name || t("platform.plans.editor.unnamed") })}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving} loading={saving}>
            {saving ? t("platform.plans.editor.saving") : isNew ? t("platform.plans.editor.createTitle") : t("platform.plans.editor.saveChanges")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {isNew && (
          <Field label={t("platform.plans.field.planId")} hint={t("platform.plans.field.planIdHint")} required>
            <Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} placeholder={t("platform.plans.field.planIdPlaceholder")} className="font-mono" />
          </Field>
        )}
        <Field label={t("platform.plans.field.name")} required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("platform.plans.field.namePlaceholder")} />
        </Field>
        <Field label={t("platform.plans.field.priceId")} hint={t("platform.plans.field.priceIdHint")} required>
          <Input value={form.stripePriceId} onChange={(e) => setForm({ ...form, stripePriceId: e.target.value })} placeholder="price_…" className="font-mono" />
        </Field>
        <Field label={t("platform.plans.field.productId")} hint={t("platform.plans.field.productIdHint")} optional>
          <Input value={form.stripeProductId} onChange={(e) => setForm({ ...form, stripeProductId: e.target.value })} placeholder="prod_…" className="font-mono" />
        </Field>
        <Field label={t("platform.plans.field.currency")}>
          <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toLowerCase() })} maxLength={3} className="font-mono uppercase" />
        </Field>
        <Field label={t("platform.plans.field.interval")}>
          <Select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })}>
            <option value="day">{t("platform.plans.interval.day")}</option>
            <option value="week">{t("platform.plans.interval.week")}</option>
            <option value="month">{t("platform.plans.interval.month")}</option>
            <option value="year">{t("platform.plans.interval.year")}</option>
          </Select>
        </Field>
        <Field label={t("platform.plans.field.displayOrder")} hint={t("platform.plans.field.displayOrderHint")}>
          <Input type="number" min={0} value={form.displayOrder} onChange={(e) => setForm({ ...form, displayOrder: Number(e.target.value) })} className="tabular-nums" />
        </Field>
        <Field label={t("platform.plans.field.description")} className="sm:col-span-2" hint={t("platform.plans.field.descriptionHint")} optional>
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder={t("platform.plans.field.descriptionPlaceholder")} className="resize-none" />
        </Field>

        <div className="sm:col-span-2 rounded-sg border border-edge bg-surface-2 p-4">
          <div className="mb-1 text-base font-[600] text-ink">{t("platform.plans.entitlementsTitle")}</div>
          <p className="mb-4 text-sm leading-relaxed text-ink-3">
            {t("platform.plans.entitlementsBody")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {(Object.keys(ENTITLEMENT_LABEL_KEYS) as EntitlementKey[]).map((key) => (
              <Field
                key={key}
                label={entitlementLabel(key)}
                hint={key === "max_prints_per_period" ? t("platform.plans.entitlement.printsHint") : undefined}
              >
                <Input value={String(form.entitlements[key])} onChange={(e) => updateEntitlement(key, e.target.value)} placeholder={t("platform.plans.entitlement.placeholder")} className="tabular-nums" />
              </Field>
            ))}
          </div>
        </div>

        <label className="flex items-start justify-between gap-4 rounded-sg border border-edge bg-surface-2 px-4 py-3">
          <span className="min-w-0">
            <span className="block text-base font-[550] text-ink">{t("platform.plans.editor.activeTitle")}</span>
            <span className="mt-0.5 block text-sm text-ink-3">{t("platform.plans.editor.activeBody")}</span>
          </span>
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-brand" />
        </label>
        <label className="flex items-start justify-between gap-4 rounded-sg border border-edge bg-surface-2 px-4 py-3">
          <span className="min-w-0">
            <span className="block text-base font-[550] text-ink">{t("platform.plans.editor.publicTitle")}</span>
            <span className="mt-0.5 block text-sm text-ink-3">{t("platform.plans.editor.publicBody")}</span>
          </span>
          <input type="checkbox" checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-brand" />
        </label>
      </div>

      {localError && (
        <Callout tone="bad" className="mt-4" icon={<CircleAlert className="h-4 w-4" aria-hidden />}>
          <span role="alert">{localError}</span>
        </Callout>
      )}
    </Modal>
  );
}
