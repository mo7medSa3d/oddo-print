"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, Field, Select } from "./ui";
import { useI18n } from "../i18n/react";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { codeMessageKey } from "../lib/api-error-keys";
import {
  ANNUAL_DISCOUNT_PERCENT,
  computePlanTermPricing,
  evaluatePlanChangeEligibility,
  formatPlanTermPriceDisplay,
  type BillingTerm,
} from "../lib/plan-price";

export type SubscriptionPlanOption = {
  id: string;
  name: string;
  priceMinorUnits?: number | null;
  priceCurrency?: string | null;
  entitlements: Record<string, unknown>;
};

export type CustomerSubscriptionRequest = {
  id: string; reference: string; status: string; planId: string; term: string; createdAt: string;
  requestedMonthlyQuota?: number | null; whatsappUrl?: string | null;
  approvalModified?: boolean; approvedPlanId?: string | null; approvedTerm?: string | null; approvedMonthlyQuota?: number | null;
};

/** A request records customer intent; only the Platform Owner changes entitlements. */
export function BillingActions({
  plans,
  selectedPlanId,
  currentPlanId,
  isOwner,
  status,
  expiringSoon = false,
  initialRequest,
  externalRequest,
  onRequestCreated,
  currentTerm,
  controlledTerm,
  onTermChange,
}: {
  plans: SubscriptionPlanOption[];
  selectedPlanId?: string;
  currentPlanId?: string | null;
  isOwner: boolean;
  status: "awaiting_activation" | "active" | "expired" | "suspended";
  expiringSoon?: boolean;
  initialRequest?: CustomerSubscriptionRequest | null;
  externalRequest?: CustomerSubscriptionRequest | null;
  onRequestCreated?: (request: CustomerSubscriptionRequest) => void;
  currentTerm?: string | null;
  controlledTerm?: BillingTerm;
  onTermChange?: (term: BillingTerm) => void;
}) {
  const { t, locale, formatNumber, formatDateTime } = useI18n();
  const router = useRouter();
  const [planId, setPlanId] = useState(() =>
    plans.some(plan => plan.id === selectedPlanId)
      ? selectedPlanId!
      : plans.some(plan => plan.id === currentPlanId)
        ? currentPlanId!
        : plans[0]?.id ?? "",
  );
  const [internalTerm, setInternalTerm] = useState<BillingTerm>(currentTerm === "yearly" ? "yearly" : "monthly");
  const term: BillingTerm = controlledTerm ?? internalTerm;
  const setTerm = (next: BillingTerm) => {
    setInternalTerm(next);
    onTermChange?.(next);
  };

  const [internalRequest, setInternalRequest] = useState(initialRequest ?? null);
  const request = externalRequest !== undefined ? externalRequest : internalRequest;
  // On an active workspace the completed request is history, not a permanent success banner.
  const [showRequestForm, setShowRequestForm] = useState(() =>
    status !== "active" || (!!selectedPlanId && selectedPlanId !== currentPlanId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flight = useRef(false);
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);
  const selectedPlan = plans.find(plan => plan.id === planId);
  const pending = request?.status === "pending";

  const formEligibility = selectedPlan
    ? evaluatePlanChangeEligibility({
        status,
        currentPlanId,
        currentTerm,
        targetPlanId: selectedPlan.id,
        targetTerm: term,
        expiringSoon,
        pendingRequest: pending && request ? { planId: request.planId, term: request.term } : null,
      })
    : null;

  const computedPricing = selectedPlan
    ? computePlanTermPricing(selectedPlan.priceMinorUnits, selectedPlan.priceCurrency, term)
    : null;
  const formattedPricing = selectedPlan
    ? formatPlanTermPriceDisplay(selectedPlan.priceMinorUnits, selectedPlan.priceCurrency, term, locale)
    : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!isOwner || flight.current || pending || !selectedPlan || (formEligibility && !formEligibility.allowed)) return;
    flight.current = true; setBusy(true); setError("");
    try {
      const fingerprint = `${planId}:${term}`;
      if (idempotency.current?.fingerprint !== fingerprint) idempotency.current = { fingerprint, key: crypto.randomUUID() };
      const payload: Record<string, unknown> = { planId, term };
      if (computedPricing) {
        payload.quotedAmountMinorUnits = computedPricing.billedAmountMinorUnits;
      }
      const response = await fetchWithTimeout("/api/subscription-requests", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency.current.key },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body.code === "SUBSCRIPTION_REQUEST_ALREADY_PENDING") {
          setError(t("v4.subscription.pendingAlready"));
          router.refresh();
        } else {
          setError(t(codeMessageKey(body.code) ?? "v4.onboarding.failed"));
        }
        return;
      }
      if (!body.request?.reference) { setError(t("v4.onboarding.failed")); return; }
      setInternalRequest(body.request);
      onRequestCreated?.(body.request as CustomerSubscriptionRequest);
      router.refresh();
    } catch { setError(t("v4.onboarding.failed")); }
    finally { flight.current = false; setBusy(false); }
  }

  return <div className="space-y-4" id="billing-actions">
    {!isOwner ? <Callout tone="info" title={t("v4.subscription.ownerTitle")}>
      {t("v4.subscription.ownerBody")}
    </Callout> : pending && request ? <Callout tone="info" title={t("v4.onboarding.requestReceived")}>
      <p>{t("v4.subscription.requestPending")}</p>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-ink-3">{t("v4.onboarding.reference")}</dt><dd className="font-medium text-ink"><bdi dir="ltr" className="break-all font-mono">{request.reference}</bdi></dd></div>
        <div><dt className="text-ink-3">{t("v4.onboarding.requestedAt")}</dt><dd className="font-medium tabular-nums text-ink">{formatDateTime(request.createdAt)}</dd></div>
        <div><dt className="text-ink-3">{t("v4.subscription.requestedPlan")}</dt><dd className="font-medium text-ink">{plans.find(plan => plan.id === request.planId)?.name ?? request.planId}</dd></div>
        <div><dt className="text-ink-3">{t("v4.onboarding.term")}</dt><dd className="font-medium text-ink">{t(request.term === "yearly" ? "v4.onboarding.yearly" : request.term === "custom" ? "v4.subscription.custom" : "v4.onboarding.monthly")}</dd></div>
        {typeof request.requestedMonthlyQuota === "number" && <div><dt className="text-ink-3">{t("v4.subscription.allowance")}</dt><dd className="font-medium text-ink"><bdi dir="ltr" className="tabular-nums">{formatNumber(request.requestedMonthlyQuota)}</bdi></dd></div>}
      </dl>
      <div className="mt-4 flex flex-wrap gap-3">
        {request.whatsappUrl && /^https:\/\//i.test(request.whatsappUrl) && <Button href={request.whatsappUrl} target="_blank" rel="noopener noreferrer" variant="primary">{t("v4.onboarding.whatsapp")}</Button>}
        <Button variant="secondary" onClick={() => router.refresh()}>{t("v4.onboarding.refresh")}</Button>
      </div>
    </Callout> : <>
      {request && <details className="rounded-xl border border-edge-subtle bg-surface-2/50 px-4 py-3">
        <summary className="min-h-6 cursor-pointer rounded-sm text-sm text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
          {t("v4.subscription.lastRequest")}
        </summary>
        <div className="mt-3 space-y-2 border-t border-edge-subtle pt-3 text-sm text-ink-3">
          <p>{t(request.status === "approved"
            ? request.approvalModified ? "v4.subscription.approvedWithChanges" : "v4.subscription.requestApproved"
            : "v4.subscription.requestRejected")}</p>
          <p><bdi dir="ltr" className="break-all font-mono">{request.reference}</bdi></p>
          {request.status === "approved" && request.approvalModified && <p>
            {t("v4.subscription.approvedTerms")}: {plans.find(plan => plan.id === request.approvedPlanId)?.name ?? request.approvedPlanId}
            {" · "}{t(request.approvedTerm === "yearly" ? "v4.onboarding.yearly" : request.approvedTerm === "custom" ? "v4.subscription.custom" : "v4.onboarding.monthly")}
            {typeof request.approvedMonthlyQuota === "number" && <>{" · "}<bdi dir="ltr" className="tabular-nums">{formatNumber(request.approvedMonthlyQuota)}</bdi></>}
          </p>}
        </div>
      </details>}
      {!showRequestForm ? <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-sm text-ink-3">{t("v4.subscription.requestBody")}</p>
        <Button type="button" variant="secondary" onClick={() => setShowRequestForm(true)}>
          {t("v4.subscription.openRequestForm")}
        </Button>
      </div> : <form onSubmit={submit} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">
            {t(status === "active" ? "v4.subscription.changeRenew" : status === "suspended" ? "v4.subscription.reviewAccess" : "v4.onboarding.request")}
          </h2>
          {status === "active" && <Button type="button" size="sm" variant="secondary" disabled={busy}
            onClick={() => setShowRequestForm(false)}>{t("v4.subscription.closeRequestForm")}</Button>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("onboarding.choosePlanLegend")} htmlFor="request-plan">
            <Select id="request-plan" value={planId} onChange={event => setPlanId(event.target.value)}
              disabled={busy || plans.length === 0} required>
              {plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
            </Select>
          </Field>
          <Field label={t("v4.onboarding.term")} htmlFor="request-term">
            <Select id="request-term" value={term} onChange={event => setTerm(event.target.value === "yearly" ? "yearly" : "monthly")} disabled={busy}>
              <option value="monthly">{t("v4.onboarding.monthly")}</option>
              <option value="yearly">{t("v4.onboarding.yearly")} (-{ANNUAL_DISCOUNT_PERCENT}%)</option>
            </Select>
          </Field>
        </div>
        {formattedPricing && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge-subtle bg-surface-2 px-4 py-3 text-sm">
            <span className="text-ink-3">{t("v4.pricing.publishedPrice")}</span>
            <span className="flex items-center gap-2 font-semibold tabular-nums text-ink" dir="ltr">
              <span>{formattedPricing.billedTotal.amount} {formattedPricing.billedTotal.currency}</span>
              {term === "yearly" && formattedPricing.discountPercent > 0 && (
                <span className="rounded-full bg-ok-bg px-2 py-0.5 text-xs font-semibold text-ok">
                  -{formattedPricing.discountPercent}%
                </span>
              )}
            </span>
          </div>
        )}
        {formEligibility && !formEligibility.allowed && (
          <Callout tone="info" title={t(formEligibility.reason === "already_on_yearly" ? "billing.planAction.alreadyOnYearly" : "billing.planAction.currentPlan")}>
            {t(formEligibility.reason === "already_on_yearly" ? "errors.subscriptionYearlyActive" : "errors.subscriptionAlreadyActive")}
          </Callout>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <Button type="submit" variant="primary" disabled={busy || !selectedPlan || (formEligibility ? !formEligibility.allowed : false)} loading={busy}>
            {t("v4.subscription.submitRequest")}
          </Button>
          {plans.length === 0 && <p className="text-sm text-ink-3">{t("onboarding.noPlansBody")}</p>}
        </div>
      </form>}
    </>}
    {error && <Callout tone="bad" title={t("errors.operationFailed")}>{error}</Callout>}
  </div>;
}
