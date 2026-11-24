"use client";

import { useState } from "react";
import { CalendarClock, Settings2 } from "lucide-react";
import { Button, Card } from "../ui";
import { adminJson, controlClass } from "./ManualAdmin";
import { useI18n } from "../../i18n/react";
import type { MessageKey } from "../../i18n/messages/en";
import { useCallback } from "react";
import { formatManualCalendarDate } from "../../lib/manual-calendar-date";

export type ManualSubscription = {
  planId: string;
  planName: string;
  status: string;
  effectiveStatus: string;
  subscriptionType: string;
  monthlyQuota: number | null;
  term: string;
  currentPeriodStart: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  internalReference: string | null;
  revision: number;
  monthlyUsed: number;
  nextReset: string;
  /** Computed by Gateway from the authoritative database clock, never render time. */
  canReactivate?: boolean;
};
export type ManualPlan = {
  id: string;
  name: string;
  description: string;
  entitlements: Record<string, number | string>;
  isActive: boolean;
  isPublic: boolean;
  displayOrder: number;
  priceMinorUnits?: number | null;
  priceCurrency?: string | null;
};
export type PendingSubscriptionRequest = {
  id: string;
  planId: string;
  term: string;
  requestedMonthlyQuota: number | null;
  status: string;
  requesterName: string;
  requesterEmail: string;
  createdAt: string;
};

type Action = "save" | "renew" | "extend" | "suspend" | "reactivate" | "cancel_at_end" | "revoke";
type Term = "monthly" | "yearly" | "custom";
type Preview = { body: Record<string, unknown>; key: string };

function day(value?: string | null) {
  return value ? value.slice(0, 10) : new Date().toISOString().slice(0, 10);
}
function laterDay(one?: string | null, two = day()) {
  const first = day(one);
  return first > two ? first : two;
}
function endFor(start: string, term: Term) {
  const date = new Date(start + "T00:00:00Z");
  if (!Number.isFinite(date.getTime())) return start;
  const dayOfMonth = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + (term === "yearly" ? 12 : 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(dayOfMonth, lastDay));
  return date.toISOString().slice(0, 10);
}
function instant(date: string) {
  return date + "T00:00:00.000Z";
}
function actionLabel(action: Action, t: (key: MessageKey) => string, editing: boolean, request?: PendingSubscriptionRequest) {
  if (request) return t(action === "renew" ? "v4.admin.renewRequested" : "v4.admin.activateRequested");
  if (action === "save") return t(editing ? "v4.admin.updatePlan" : "v4.admin.activateSubscription");
  return t(`v4.admin.${action}` as MessageKey);
}

export function SubscriptionEditor({
  tenantId, subscription, plans, request, preferredAction, onSaved, onConflict,
}: {
  tenantId: string;
  subscription: ManualSubscription | null;
  plans: ManualPlan[];
  request?: PendingSubscriptionRequest;
  preferredAction?: "revoke";
  onSaved: () => void;
  onConflict?: (code: string) => void;
}) {
  const { t, locale, formatNumber } = useI18n();
  // Contract dates use UTC calendar days, exactly as the previous helper did.
  const formatDate = useCallback((value: Date | string | number | null | undefined) => formatManualCalendarDate(value, locale) ?? t("common.notAvailable"), [locale, t]);
  const active = subscription?.effectiveStatus === "active";
  // A different requested plan or term is a new contract, not a renewal of
  // the former annual contract. Renewal is valid only for the same terms.
  const renewalFromRequest = !!request && active &&
    request.planId === subscription?.planId && request.term === subscription?.term &&
    !!subscription?.currentPeriodEnd;
  // Gateway evaluates the finite deadline with PostgreSQL time. Rendering must
  // never use Date.now() to guess whether this subscription is reactivatable.
  const canReactivate = subscription?.status === "suspended" && subscription.canReactivate === true;
  const initialAction: Action = !request && active && preferredAction === "revoke"
    ? "revoke" : renewalFromRequest ? "renew" : request ? "save"
    : canReactivate ? "reactivate" : "save";
  const initialTerm: Term = request && ["monthly", "yearly", "custom"].includes(request.term)
    ? request.term as Term
    : subscription?.term === "yearly" || subscription?.term === "custom"
      ? subscription.term : "monthly";
  const initialStart = (active && !request) || renewalFromRequest ? day(subscription?.currentPeriodStart) : day();
  const renewalBase = laterDay(subscription?.currentPeriodEnd);
  const initialEnd = renewalFromRequest ? endFor(renewalBase, initialTerm)
    : active && !request && subscription?.currentPeriodEnd
      ? day(subscription.currentPeriodEnd) : endFor(initialStart, initialTerm);
  const selectedRequestPlan = plans.find(plan => plan.id === request?.planId);
  const initialQuota = request?.requestedMonthlyQuota ??
    selectedRequestPlan?.entitlements.max_prints_per_period ??
    subscription?.monthlyQuota ?? plans[0]?.entitlements.max_prints_per_period ?? 1000;

  const [action, setAction] = useState<Action>(initialAction);
  const [planId, setPlanId] = useState(request?.planId ?? subscription?.planId ?? plans[0]?.id ?? "");
  const [quota, setQuota] = useState(String(initialQuota));
  const [term, setTerm] = useState<Term>(initialTerm);
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [type, setType] = useState(subscription?.subscriptionType ?? "paid");
  const [reference, setReference] = useState(subscription?.internalReference ?? "");
  const [editDates, setEditDates] = useState(false);
  const [leavePending, setLeavePending] = useState(false);
  const [allowRequestChanges, setAllowRequestChanges] = useState(false);
  const [canRefresh, setCanRefresh] = useState(false);
  const [lastErrorCode, setLastErrorCode] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const full = action === "save" || action === "renew";
  const editing = action === "save" && active && !request;
  const activating = action === "save" && !editing;
  const linkedActivation = !!request && action === "save";
  const linkedTermEnd = !!request && full && term !== "custom";
  const showTerm = full && (action === "renew" || activating || editDates);
  const showCustomDates = full && showTerm && term === "custom";
  const title = activating && leavePending && !request ? t("v4.admin.savePendingSubscription") : actionLabel(action, t, editing, request);
  const requestTermsDiffer = !!request && (planId !== request.planId || term !== request.term ||
    Number(quota) !== request.requestedMonthlyQuota);

  const extraActions: Action[] = !subscription || request ? [] : [
    ...(active && subscription.currentPeriodEnd ? ["renew", "extend"] as Action[] : []),
    ...(active ? ["suspend"] as Action[] : []),
    ...(active && subscription.currentPeriodEnd && !subscription.cancelAtPeriodEnd ? ["cancel_at_end"] as Action[] : []),
    ...(active ? ["revoke"] as Action[] : []),
    ...(canReactivate ? ["reactivate"] as Action[] : []),
    ...(active && action !== "save" ? ["save"] as Action[] : []),
  ].filter(value => value !== action);

  function selectAction(next: Action) {
    setError("");
    setCanRefresh(false);
    setPreview(null);
    setAction(next);
    if (next === "renew" && subscription?.currentPeriodEnd) {
      setStart(day(subscription.currentPeriodStart));
      setEnd(endFor(laterDay(subscription.currentPeriodEnd), term));
    } else if (next === "extend") {
      setEnd(endFor(laterDay(subscription?.currentPeriodEnd), "monthly"));
    } else if (next === "save") {
      // Returning from renewal/extension must never carry their expiry into a plan-only edit.
      setEditDates(false);
      if (active) {
        setStart(day(subscription?.currentPeriodStart));
        setEnd(day(subscription?.currentPeriodEnd));
        const original = subscription?.term;
        if (original === "monthly" || original === "yearly" || original === "custom") setTerm(original);
      } else {
        setStart(day());
        setEnd(endFor(day(), term));
      }
    }
    // For sensitive actions the only input in confirmation is the reason.
    if (!["save", "renew", "extend"].includes(next)) {
      setPreview({ body: { action: next, expectedRevision: subscription?.revision ?? 0 }, key: crypto.randomUUID() });
    }
  }

  function changeTerm(value: Term) {
    setTerm(value);
    if (value !== "custom") {
      setEnd(endFor(action === "renew" ? laterDay(subscription?.currentPeriodEnd) : start, value));
    }
  }
  function toggleRequestedTerms() {
    if (!request) return;
    const next = !allowRequestChanges;
    setAllowRequestChanges(next);
    setError("");
    setPreview(null);
    if (!next) {
      setPlanId(request.planId);
      setQuota(String(request.requestedMonthlyQuota ??
        plans.find(plan => plan.id === request.planId)?.entitlements.max_prints_per_period ?? 1000));
      const originalTerm: Term = ["monthly","yearly","custom"].includes(request.term) ? request.term as Term : "monthly";
      setTerm(originalTerm);
      setEnd(endFor(action === "renew" ? laterDay(subscription?.currentPeriodEnd) : start, originalTerm));
    }
  }

  function prepare(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (full) {
      const limit = Number(quota);
      if (!planId || !Number.isSafeInteger(limit) || limit < 1 || limit > 2147483647) {
        setError(t("v4.admin.invalidQuota"));
        return;
      }
    }
    if ((full || action === "extend") &&
      (Date.parse(instant(end)) <= Date.parse(instant(start)) ||
       (action === "renew" && subscription?.currentPeriodEnd &&
        Date.parse(instant(end)) <= Date.parse(instant(day(subscription.currentPeriodEnd)))) ||
       (action === "extend" && subscription?.currentPeriodEnd &&
        Date.parse(instant(end)) <= Date.parse(instant(day(subscription.currentPeriodEnd)))))) {
      setError(t("v4.admin.invalidDates"));
      return;
    }
    const body: Record<string, unknown> = {
      action, expectedRevision: subscription?.revision ?? 0,
      ...(full ? {
        planId, subscriptionType: type, monthlyQuota: Number(quota), term,
        startDate: instant(start), endDate: instant(end),
        status: activating && !request && leavePending ? "awaiting_activation" : "active",
        internalReference: reference,
      } : {}),
      ...(action === "extend" ? { endDate: instant(end) } : {}),
      ...(request && full ? { requestId:request.id, ...(allowRequestChanges ? { allowRequestChanges: true } : {}) } : {}),
    };
    setPreview({ body, key: crypto.randomUUID() });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!preview || busy || !reason.trim()) return;
    setBusy(true);
    setError("");
    setCanRefresh(false);
    try {
      await adminJson("/api/platform/tenants/" + encodeURIComponent(tenantId) + "/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": preview.key },
        body: JSON.stringify({ ...preview.body, reason: reason.trim() }),
      });
      setPreview(null);
      onSaved();
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "";
      const recoverable = ["SUBSCRIPTION_REVISION_CONFLICT", "SUBSCRIPTION_REQUEST_CONFLICT", "SUBSCRIPTION_REQUEST_TERMS_MISMATCH"].includes(code);
      setCanRefresh(recoverable);
      setLastErrorCode(code);
      const label = code === "SUBSCRIPTION_REVISION_CONFLICT" ? "revisionConflict"
        : code === "SUBSCRIPTION_REQUEST_CONFLICT" ? "requestConflict"
        : code === "SUBSCRIPTION_REQUEST_TERMS_MISMATCH" ? "requestTermsMismatch"
        : code === "SESSION_EXPIRED" || code === "UNAUTHORIZED" ? "sessionExpired"
        : code === "SUBSCRIPTION_DATES_INVALID" ? "invalidDates"
        : code === "SUBSCRIPTION_REASON_REQUIRED" ? "reasonRequired" : "saveError";
      setError(t(`v4.admin.${label}` as MessageKey));
    } finally {
      setBusy(false);
    }
  }

  const field = (name: string, children: React.ReactNode) => (
    <label className="block space-y-1.5 text-sm">
      <span className="block font-medium text-ink-2">{t(`v4.admin.${name}` as MessageKey)}</span>{children}
    </label>
  );

  return <Card className="max-w-4xl p-5 sm:p-6">
    <div className="mb-5 flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
        <Settings2 className="h-5 w-5" aria-hidden />
      </span>
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {request && <p className="text-sm text-ink-3">{t("v4.admin.requestDecisionHint")}</p>}
      </div>
    </div>
    {error && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-bad/20 p-3 text-sm text-bad">
      <span>{error}</span>
      {canRefresh && onConflict && <Button type="button" variant="secondary" onClick={() => onConflict(lastErrorCode)}>{t("v4.admin.refreshAndReview")}</Button>}
    </div>}

    {preview ? <form onSubmit={save} aria-busy={busy || undefined} className="space-y-5">
      <h3 className="font-semibold">{t("v4.admin.previewTitle")}</h3>
      {action === "revoke" && <p className="rounded-lg border border-bad/25 p-3 text-sm text-bad">{t("v4.admin.endSubscriptionWarning")}</p>}
      <dl className="grid gap-x-6 gap-y-3 rounded-xl bg-surface-2 p-4 text-sm sm:grid-cols-2">
        <div><dt className="text-ink-3">{t("v4.admin.action")}</dt><dd className="mt-1 font-semibold">{title}</dd></div>
        {full && <>
          <div><dt className="text-ink-3">{t("v4.admin.plan")}</dt><dd className="mt-1 font-semibold">{plans.find(plan => plan.id === planId)?.name ?? t("v4.admin.notRecorded")}</dd></div>
          <div><dt className="text-ink-3">{t("v4.admin.quota")}</dt><dd className="mt-1 font-semibold tabular-nums">{formatNumber(Number(quota))}</dd></div>
          <div><dt className="text-ink-3">{t("v4.admin.term")}</dt><dd className="mt-1">{t(`v4.admin.${term}` as MessageKey)}</dd></div>
          {request && <div><dt className="text-ink-3">{t("v4.admin.requestedTerms")}</dt>
            <dd className="mt-1 tabular-nums">{plans.find(plan => plan.id === request.planId)?.name ?? request.planId} · {t(`v4.admin.${request.term}` as MessageKey)}
              {request.requestedMonthlyQuota !== null ? " · " + formatNumber(request.requestedMonthlyQuota) : ""}
            </dd>
          </div>}
          {requestTermsDiffer && <div><dt className="text-ink-3">{t("v4.admin.approvedTerms")}</dt>
            <dd className="mt-1 font-semibold tabular-nums">{plans.find(plan => plan.id === planId)?.name ?? planId} · {t(`v4.admin.${term}` as MessageKey)} · {formatNumber(Number(quota))}</dd>
          </div>}
          <div><dt className="text-ink-3">{t("v4.admin.type")}</dt><dd className="mt-1">{t(`v4.admin.${type}` as MessageKey)}</dd></div>
          <div><dt className="text-ink-3">{t(`v4.admin.${action === "renew" ? "contractStart" : "start"}` as MessageKey)}</dt><dd className="mt-1 tabular-nums">{linkedActivation ? t("v4.admin.startsAtApproval") : <time dateTime={start}>{formatDate(start)}</time>}</dd></div>
          {activating && leavePending && !request && <div><dt className="text-ink-3">{t("v4.admin.status")}</dt><dd>{t("v4.admin.awaiting_activation")}</dd></div>}
        </>}
        {(full || action === "extend") && <div><dt className="text-ink-3">{t("v4.admin.end")}</dt><dd className="mt-1 tabular-nums">{linkedTermEnd ? t("v4.admin.endsFromApproval") : <time dateTime={end}>{formatDate(end)}</time>}</dd></div>}
      </dl>
      {field("reason", <textarea className={controlClass} required disabled={busy} maxLength={500} rows={2}
        value={reason} onChange={event => {
          setReason(event.target.value);
          // A changed reason changes the request digest, so use a new operation key.
          setPreview(current => current ? { ...current, key: crypto.randomUUID() } : current);
        }} />)}
      {requestTermsDiffer && <p className="text-sm text-ink-3">{t("v4.admin.changeReasonHint")}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy || !reason.trim() || (requestTermsDiffer && (!allowRequestChanges || reason.trim().length < 10))} loading={busy}>{busy ? t("common.saving") : t("v4.admin.confirm")}</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => {
          setPreview(null);
        }}>{t("v4.admin.cancel")}</Button>
      </div>
    </form> : <>
      {full ? <form className="space-y-4" onSubmit={prepare}>
        {request && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 p-3 text-sm">
          <span>{t("v4.admin.requestedTerms")}: <strong>{plans.find(plan => plan.id === request.planId)?.name ?? request.planId} · {t(`v4.admin.${request.term}` as MessageKey)}</strong></span>
          <Button type="button" variant="secondary" onClick={toggleRequestedTerms}>
            {t(`v4.admin.${allowRequestChanges ? "restoreRequestedTerms" : "adjustRequestTerms"}` as MessageKey)}
          </Button>
          {allowRequestChanges && <p className="w-full text-ink-3">{t("v4.admin.adjustRequestNotice")}</p>}
        </div>}
        <div className="grid gap-4 sm:grid-cols-2">
          {field("plan", <select className={controlClass} required disabled={!!request && !allowRequestChanges} value={planId}
            onChange={event => {
              setPlanId(event.target.value);
              const selected = plans.find(plan => plan.id === event.target.value);
              const allowance = selected?.entitlements.max_prints_per_period;
              if (typeof allowance === "number") setQuota(String(allowance));
            }}>
            {plans.filter(plan => plan.isActive || plan.id === planId).map(plan =>
              <option key={plan.id} value={plan.id}>{plan.name}</option>)}
          </select>)}
          {field("quota", <input className={`${controlClass} tabular-nums`} required type="number" min={1} max={2147483647} step={1}
            disabled={!!request && !allowRequestChanges && request.requestedMonthlyQuota !== null}
            value={quota} onChange={event => setQuota(event.target.value)} />)}
          {showTerm && field("term", <select className={controlClass} value={term} disabled={!!request && !allowRequestChanges}
            onChange={event => changeTerm(event.target.value as Term)}>
            {(["monthly", "yearly", "custom"] as const).map(v => <option key={v} value={v}>{t(`v4.admin.${v}` as MessageKey)}</option>)}
          </select>)}
          {showCustomDates && action === "save" && !request && field("start", <input className={controlClass}
            type="date" required value={start} onChange={event => setStart(event.target.value)} />)}
          {showCustomDates && field("end", <input className={controlClass} type="date" required value={end}
            onChange={event => setEnd(event.target.value)} />)}
        </div>

        {showTerm && !showCustomDates && <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 p-3 text-sm">
          <CalendarClock className="h-4 w-4 text-brand" aria-hidden />
          <span className="text-ink-3">{t("v4.admin.end")}:</span>
          {request ? <span className="font-semibold">{t("v4.admin.endsFromApproval")}</span>
            : <time dateTime={end} className="font-semibold tabular-nums">{formatDate(end)}</time>}
        </div>}

        {request && full && <p className="text-sm leading-6 text-ink-3">{t(`v4.admin.${action === "renew" ? "renewalTimeNotice" : term === "custom" ? "customDeadlineOnApproval" : "approvalDateNotice"}` as MessageKey)}</p>}
        <details className="rounded-lg border border-edge-subtle px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-ink-2">{t("v4.admin.optionalDetails")}</summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {field("type", <select className={controlClass} value={type} onChange={event => setType(event.target.value)}>
              {(["free", "paid"] as const).map(v => <option key={v} value={v}>{t(`v4.admin.${v}` as MessageKey)}</option>)}
            </select>)}
            {field("internalReference", <input className={controlClass} maxLength={200} value={reference}
              onChange={event => setReference(event.target.value)} />)}
            {editing && <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editDates} onChange={event => setEditDates(event.target.checked)} />
              {t("v4.admin.editContractDates")}
            </label>}
            {action === "save" && (activating || editDates) && term !== "custom" &&
              field("start", <input className={controlClass} type="date" required value={start} onChange={event => {
                setStart(event.target.value);
                setEnd(endFor(event.target.value, term));
              }} />)}
            {activating && !request && <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={leavePending} onChange={event => setLeavePending(event.target.checked)} />
              {t("v4.admin.leavePending")}
            </label>}
          </div>
        </details>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!planId || busy}>{t("v4.admin.preview")}</Button>
        </div>
      </form> : action === "extend" ? <form onSubmit={prepare} className="space-y-4">
        {field("end", <input className={controlClass} type="date" required value={end} onChange={event => setEnd(event.target.value)} />)}
        <Button type="submit">{t("v4.admin.preview")}</Button>
      </form> : <div className="space-y-3">
        <p className="text-sm text-ink-3">{t("v4.admin.actionRequiresConfirmation")}</p>
        <Button type="button" onClick={() => setPreview({
          body: { action, expectedRevision: subscription?.revision ?? 0 },
          key: crypto.randomUUID(),
        })}>{t("v4.admin.preview")}</Button>
      </div>}
      {!!extraActions.length && <details className="mt-5 rounded-lg border border-edge-subtle px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-ink-2">{t("v4.admin.manageExtraActions")}</summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {extraActions.map(v => <Button key={v} type="button" variant="secondary"
            onClick={() => selectAction(v)}>{v === "save" ? t("v4.admin.updatePlan") : t(`v4.admin.${v}` as MessageKey)}</Button>)}
        </div>
      </details>}
    </>}
  </Card>;
}
