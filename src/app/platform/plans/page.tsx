"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from "../../../components/ui";
import { adminJson, controlClass } from "../../../components/platform/ManualAdmin";
import type { ManualPlan } from "../../../components/platform/SubscriptionEditor";
import { formatPlanPrice, parsePlanPriceAmount } from "../../../lib/plan-price";
import { useI18n } from "../../../i18n/react";
import type { MessageKey } from "../../../i18n/messages/en";

const empty = {
  id: "",
  name: "",
  description: "",
  monthlyQuota: 1000000,
  maxAgents: 5,
  maxPrinters: 15,
  priceAmount: "",
  priceCurrency: "USD" as "USD" | "SAR",
  isActive: true,
  isPublic: true,
  displayOrder: 0,
};

export default function Plans() {
  const { t, locale, formatNumber } = useI18n();
  const [plans, setPlans] = useState<ManualPlan[]>([]);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const alertRef = useRef<HTMLParagraphElement>(null);
  // Guide form rule: move focus to the first error (the page-level
  // alert sits above both plan forms, so it gets its own ref).
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    adminJson("/api/platform/plans", { signal: controller.signal })
      .then((d) => { if (live) { setPlans(d.plans); setError(""); } })
      .catch(() => { if (live) { setPlans([]); setError(t("v4.admin.loadError")); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [tick, t]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!preview || busy) return;
    setBusy(true);
    try {
      await adminJson("/api/platform/plans" + (editing ? `/${encodeURIComponent(editing)}` : ""), {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": preview },
        body: JSON.stringify({
          ...form,
          priceAmount: form.priceAmount === "" ? null : form.priceAmount,
          priceCurrency: form.priceAmount === "" ? null : form.priceCurrency,
        }),
      });
      setOpen(false);
      setPreview(null);
      setTick((x) => x + 1);
      setError("");
    } catch {
      setError(t("v4.admin.saveError"));
    } finally {
      setBusy(false);
    }
  }

  function edit(p?: ManualPlan) {
    setForm(p ? {
      id: p.id,
      name: p.name,
      description: p.description,
      monthlyQuota: Number.isFinite(Number(p.entitlements.max_prints_per_period)) ? Number(p.entitlements.max_prints_per_period) : 1000000,
      maxAgents: Number.isFinite(Number(p.entitlements.max_agents)) ? Number(p.entitlements.max_agents) : 5,
      maxPrinters: Number.isFinite(Number(p.entitlements.max_printers)) ? Number(p.entitlements.max_printers) : 15,
      priceAmount: p.priceMinorUnits == null ? "" : (p.priceMinorUnits / 100).toFixed(2),
      priceCurrency: p.priceCurrency === "SAR" ? "SAR" : "USD",
      isActive: p.isActive,
      isPublic: p.isPublic,
      displayOrder: p.displayOrder,
    } : empty);
    setEditing(p?.id ?? null);
    setPreview(null);
    setOpen(true);
    setError("");
  }

  return (
    <div className="space-y-5">
      <PageHeader
        variant="inline"
        title={t("v4.admin.plansTitle")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link className="rounded-lg border border-edge px-4 py-2 text-sm transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35" href="/platform/subscriptions">
              {t("v4.admin.overviewLink")}
            </Link>
            <Button onClick={() => edit()}>{t("v4.admin.newPlan")}</Button>
          </div>
        }
      />
      {error && (!open && plans.length === 0
        ? <ErrorState title={t("v4.admin.plansTitle")} message={error} retry={() => { setLoading(true); setError(""); setTick((x) => x + 1); }} />
        : <p ref={alertRef} tabIndex={-1} role="alert" className="text-bad">{error}</p>)}
      {open && (
        <Card className="p-5">
          <h2 className="mb-4 text-xl font-medium">
            {t(`v4.admin.${editing ? "editPlan" : "newPlan"}` as MessageKey)}
          </h2>
          {preview ? (
            <form onSubmit={save} aria-busy={busy || undefined} className="space-y-4">
              <p className="tabular-nums"><bdi dir="auto">{form.name}</bdi> · {formatNumber(form.maxAgents)} {t("v4.admin.maxAgents")} · {formatNumber(form.maxPrinters)} {t("v4.admin.maxPrinters")} · {form.priceAmount ? <bdi dir="ltr">{form.priceAmount} {form.priceCurrency}</bdi> : t("v4.admin.priceOnRequest")}</p>
              <div className="flex gap-3">
                <Button type="submit" disabled={busy} loading={busy}>{busy ? t("common.saving") : t("v4.admin.confirm")}</Button>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => setPreview(null)}>{t("v4.admin.cancel")}</Button>
              </div>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (form.priceAmount !== "" && parsePlanPriceAmount(form.priceAmount) === null) {
                  setError(t("v4.admin.priceInvalid"));
                  return;
                }
                setError("");
                setPreview(crypto.randomUUID());
              }}
              className="space-y-4"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {(["id", "name", "description", "maxAgents", "maxPrinters", "monthlyQuota", "displayOrder"] as const).map((k) => (
                  <label key={k} className="block text-sm">
                    {t(`v4.admin.${({ id: "planId", monthlyQuota: "quota", displayOrder: "order", maxAgents: "maxAgents", maxPrinters: "maxPrinters" } as Record<string, string>)[k] ?? k}` as MessageKey)}
                    <input
                      className={k === "monthlyQuota" || k === "displayOrder" || k === "maxAgents" || k === "maxPrinters" ? `${controlClass} tabular-nums` : controlClass}
                      dir={k === "id" || k === "monthlyQuota" || k === "displayOrder" || k === "maxAgents" || k === "maxPrinters" ? "ltr" : undefined}
                      required={k !== "description"}
                      disabled={k === "id" && !!editing}
                      type={k === "monthlyQuota" || k === "displayOrder" || k === "maxAgents" || k === "maxPrinters" ? "number" : "text"}
                      min={k === "monthlyQuota" || k === "maxAgents" || k === "maxPrinters" ? 1 : 0}
                      max={k === "monthlyQuota" ? 2147483647 : k === "maxAgents" ? 1000 : k === "maxPrinters" ? 10000 : k === "displayOrder" ? 1000000 : undefined}
                      maxLength={k === "description" ? 500 : k === "id" ? 64 : 120}
                      pattern={k === "id" ? "[a-z0-9][a-z0-9_-]{1,63}" : undefined}
                      value={form[k]}
                      onChange={(e) => setForm((f) => ({ ...f, [k]: k === "monthlyQuota" || k === "displayOrder" || k === "maxAgents" || k === "maxPrinters" ? Number(e.target.value) : e.target.value }))}
                    />
                  </label>
                ))}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  {t("v4.admin.priceAmount")}
                  <input
                    className={`${controlClass} tabular-nums`}
                    dir="ltr"
                    type="text"
                    inputMode="decimal"
                    pattern="(?:0|[1-9][0-9]{0,9})(?:[.][0-9]{1,2})?"
                    maxLength={13}
                    placeholder="0.00"
                    value={form.priceAmount}
                    onChange={(e) => setForm((f) => ({ ...f, priceAmount: e.target.value }))}
                  />
                </label>
                <label className="block text-sm">
                  {t("v4.admin.priceCurrency")}
                  <select
                    className={controlClass}
                    value={form.priceCurrency}
                    onChange={(e) => setForm((f) => ({ ...f, priceCurrency: e.target.value as "USD" | "SAR" }))}
                  >
                    <option value="USD">USD</option>
                    <option value="SAR">SAR</option>
                  </select>
                </label>
              </div>
              {(["isActive", "isPublic"] as const).map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form[k]}
                    onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))}
                  />
                  {t(`v4.admin.${k === "isActive" ? "enabled" : "public"}` as MessageKey)}
                </label>
              ))}
              <div className="flex flex-wrap gap-3">
                <Button type="submit">{t("v4.admin.preview")}</Button>
                <Button type="button" variant="secondary" onClick={() => { setOpen(false); setError(""); }}>{t("v4.admin.cancel")}</Button>
              </div>
            </form>
          )}
        </Card>
      )}
      {loading && plans.length === 0 ? (
        <div role="status" aria-busy="true" aria-label={t("v4.admin.loading")}><LoadingState rows={3} /></div>
      ) : !error && plans.length === 0 ? (
        <EmptyState icon={<ListChecks className="h-6 w-6" />} title={t("v4.admin.empty")} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((p) => (
            <Card key={p.id} className="p-5">
              <h2 className="text-lg font-medium">{p.name}</h2>
              <p className="mt-2 text-sm text-ink-3">{p.description}</p>
              <div className="mt-5 grid grid-cols-2 gap-3 tabular-nums">
                <div>
                  <p className="text-2xl font-semibold">{p.entitlements.max_agents === "unlimited" ? t("v4.admin.unlimited") : formatNumber(Number(p.entitlements.max_agents ?? 5))}</p>
                  <p className="text-xs text-ink-3">{t("v4.admin.maxAgents")}</p>
                </div>
                <div>
                  <p className="text-2xl font-semibold">{p.entitlements.max_printers === "unlimited" ? t("v4.admin.unlimited") : formatNumber(Number(p.entitlements.max_printers ?? 15))}</p>
                  <p className="text-xs text-ink-3">{t("v4.admin.maxPrinters")}</p>
                </div>
              </div>
              <p className="mt-3 mb-4 text-xs text-ink-3 tabular-nums">
                {t("v4.admin.quota")}: {p.entitlements.max_prints_per_period === "unlimited" ? t("v4.admin.unlimited") : Number.isFinite(Number(p.entitlements.max_prints_per_period)) ? formatNumber(Number(p.entitlements.max_prints_per_period)) : t("common.notAvailable")}
              </p>
              <p className="mb-4 font-semibold tabular-nums">
                <bdi dir="auto">{formatPlanPrice(p.priceMinorUnits, p.priceCurrency, locale) ?? t("v4.admin.priceOnRequest")}</bdi>
              </p>
              <Button variant="secondary" onClick={() => edit(p)}>{t("v4.admin.editPlan")}</Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
