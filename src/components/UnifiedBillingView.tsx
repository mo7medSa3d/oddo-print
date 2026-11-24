"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CalendarDays, Check, CheckCircle2, Clock, Sparkles, X, AlertCircle } from "lucide-react";
import { useI18n } from "../i18n/react";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { codeMessageKey } from "../lib/api-error-keys";
import {
  ANNUAL_DISCOUNT_PERCENT,
  computePlanTermPricing,
  evaluatePlanChangeEligibility,
  formatPlanTermPriceDisplay,
  type BillingTerm,
  type UnifiedPlanRecord,
} from "../lib/plan-price";
import { Button, Callout, Card, Progress, StatusBadge, type Tone } from "./ui";
import { BillingActions, type CustomerSubscriptionRequest, type SubscriptionPlanOption } from "./BillingActions";

export type WorkspaceSubscriptionSummary = {
  status: "awaiting_activation" | "active" | "expired" | "suspended";
  statusLabel: string;
  tone: Tone;
  planId: string | null;
  planName: string;
  publishedPrice: string | null;
  typeLabel: string;
  termLabel: string;
  startDateLabel: string;
  endDateLabel: string;
  renewalNote: string;
  quotaExhausted: boolean;
  expiringSoon: boolean;
  expiringSoonDate: string;
  legacyEndMissing: boolean;
  usage: {
    used: number;
    limit: number | "unlimited";
    remaining: number | "unlimited";
    resetLabel: string;
  } | null;
};

type UnifiedBillingViewProps = {
  mode: "public" | "workspace";
  plans: UnifiedPlanRecord[];
  usingFallbackCatalog?: boolean;
  /** Public mode CTA resolver: receives planId and active term. */
  publicRole?: "anonymous" | "owner" | "member";
  /** Workspace mode props. */
  workspace?: {
    isOwner: boolean;
    selectedPlanId?: string;
    initialTerm?: BillingTerm;
    currentTerm?: string | null;
    summary: WorkspaceSubscriptionSummary;
    requestPlans: SubscriptionPlanOption[];
    initialRequest: CustomerSubscriptionRequest | null;
  };
};

type BillingToast = {
  tone: "ok" | "bad";
  title: string;
  body: string;
};

function entitlementLimitText(
  value: unknown,
  formatNumber: (n: number) => string,
  unlimitedLabel: string,
): string | null {
  if (value === "unlimited") return unlimitedLabel;
  if (typeof value === "number" && Number.isFinite(value)) return formatNumber(value);
  return null;
}

export function UnifiedBillingView({
  mode,
  plans,
  usingFallbackCatalog = false,
  publicRole = "anonymous",
  workspace,
}: UnifiedBillingViewProps) {
  const { t, locale, formatNumber } = useI18n();
  const router = useRouter();
  const [term, setTerm] = useState<BillingTerm>(() =>
    workspace?.initialTerm ?? (workspace?.currentTerm === "yearly" ? "yearly" : "monthly"),
  );
  const serverRequestKey = workspace?.initialRequest
    ? `${workspace.initialRequest.id}:${workspace.initialRequest.status}`
    : "";
  const [syncedRequestKey, setSyncedRequestKey] = useState(serverRequestKey);
  const [liveRequest, setLiveRequest] = useState<CustomerSubscriptionRequest | null>(
    () => workspace?.initialRequest ?? null,
  );
  if (syncedRequestKey !== serverRequestKey) {
    setSyncedRequestKey(serverRequestKey);
    setLiveRequest(workspace?.initialRequest ?? null);
  }
  const [submittingPlanId, setSubmittingPlanId] = useState<string | null>(null);
  const [toast, setToast] = useState<BillingToast | null>(null);
  const flightRef = useRef(false);
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activePendingRequest =
    liveRequest?.status === "pending"
      ? { planId: liveRequest.planId, term: liveRequest.term }
      : null;

  const showRequestSentToast = (planName: string, reqTerm: string, reference: string) => {
    setToast({
      tone: "ok",
      title: t("billing.toast.requestSentTitle"),
      body: t("billing.toast.requestSentBody", {
        plan: planName,
        term: t(reqTerm === "yearly" ? "v4.onboarding.yearly" : "v4.onboarding.monthly"),
        reference,
      }),
    });
  };

  const publicDestination = (plan: UnifiedPlanRecord) => {
    const query = plan.isFallback
      ? `?term=${encodeURIComponent(term)}`
      : `?plan=${encodeURIComponent(plan.id)}&term=${encodeURIComponent(term)}`;
    if (publicRole === "owner") return `/billing${query}`;
    if (publicRole === "member") return "/dashboard";
    return `/signup${query}`;
  };

  async function submitPlanCardRequest(plan: UnifiedPlanRecord) {
    if (!workspace?.isOwner || plan.isFallback || flightRef.current) return;
    const eligibility = evaluatePlanChangeEligibility({
      status: workspace.summary.status,
      currentPlanId: workspace.summary.planId,
      currentTerm: workspace.currentTerm,
      targetPlanId: plan.id,
      targetTerm: term,
      expiringSoon: workspace.summary.expiringSoon,
      pendingRequest: activePendingRequest,
    });
    if (!eligibility.allowed) return;

    flightRef.current = true;
    setSubmittingPlanId(plan.id);
    try {
      const fingerprint = `${plan.id}:${term}`;
      if (idempotencyRef.current?.fingerprint !== fingerprint) {
        idempotencyRef.current = { fingerprint, key: crypto.randomUUID() };
      }
      const computedPricing = computePlanTermPricing(plan.priceMinorUnits, plan.priceCurrency, term);
      const payload: Record<string, unknown> = { planId: plan.id, term };
      if (computedPricing) {
        payload.quotedAmountMinorUnits = computedPricing.billedAmountMinorUnits;
      }
      const response = await fetchWithTimeout("/api/subscription-requests", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyRef.current.key,
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg =
          body.code === "SUBSCRIPTION_REQUEST_ALREADY_PENDING"
            ? t("v4.subscription.pendingAlready")
            : t(codeMessageKey(body.code) ?? "v4.onboarding.failed");
        setToast({ tone: "bad", title: t("errors.operationFailed"), body: msg });
        if (body.code === "SUBSCRIPTION_REQUEST_ALREADY_PENDING") router.refresh();
        return;
      }
      if (!body.request?.reference) {
        setToast({ tone: "bad", title: t("errors.operationFailed"), body: t("v4.onboarding.failed") });
        return;
      }
      setLiveRequest(body.request as CustomerSubscriptionRequest);
      showRequestSentToast(plan.name, term, String(body.request.reference));
      router.refresh();
    } catch {
      setToast({ tone: "bad", title: t("errors.operationFailed"), body: t("v4.onboarding.failed") });
    } finally {
      flightRef.current = false;
      setSubmittingPlanId(null);
    }
  }

  const featuredIndex = plans.length === 3 ? 1 : 0;

  return (
    <div className="space-y-8">
      {/* Floating iOS-style notification toast */}
      {toast && (
        <div
          role={toast.tone === "bad" ? "alert" : "status"}
          aria-live="polite"
          className="fixed inset-x-4 bottom-5 z-50 mx-auto max-w-md sm:inset-x-auto sm:end-6 sm:w-full"
        >
          <div
            className={`glass-card flex items-start gap-3 rounded-2xl border p-4 shadow-xl backdrop-blur-xl ${
              toast.tone === "ok"
                ? "border-ok/35 bg-surface/95"
                : "border-bad/35 bg-surface/95"
            }`}
          >
            {toast.tone === "ok" ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden />
            ) : (
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-bad" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">{toast.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{toast.body}</p>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label={t("ui.closeDialog")}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      )}

      {/* Workspace active subscription overview */}
      {mode === "workspace" && workspace && (
        <section className="space-y-4">
          {workspace.summary.status !== "active" && (
            <Callout tone={workspace.summary.tone} title={workspace.summary.statusLabel}>
              <p>
                {t(
                  workspace.summary.status === "expired"
                    ? "v4.subscription.expiredBody"
                    : workspace.summary.status === "suspended"
                      ? "v4.subscription.suspendedBody"
                      : "v4.subscription.pendingBody",
                )}
              </p>
              {workspace.isOwner && workspace.summary.status === "expired" && (
                <div className="mt-3">
                  <Button size="sm" variant="secondary" href="#billing-actions">
                    {t("v4.subscription.renewRequestAction")}
                  </Button>
                </div>
              )}
            </Callout>
          )}
          {workspace.summary.quotaExhausted && (
            <Callout tone="warn" title={t("v4.subscription.quotaBlockedTitle")}>
              <p>{t("v4.subscription.quotaBlockedBody")}</p>
              <div className="mt-3">
                <Button size="sm" variant="secondary" href="#billing-actions">
                  {t("v4.subscription.quotaBlockedAction")}
                </Button>
              </div>
            </Callout>
          )}
          {!workspace.summary.quotaExhausted && workspace.summary.expiringSoon && (
            <Callout tone="warn" title={t("v4.subscription.expiringSoonTitle")}>
              <p>{t("v4.subscription.expiringSoonBody", { date: workspace.summary.expiringSoonDate })}</p>
              <div className="mt-3">
                <Button size="sm" variant="secondary" href="#billing-actions">
                  {t("v4.subscription.renewRequestAction")}
                </Button>
              </div>
            </Callout>
          )}
          {workspace.summary.legacyEndMissing && (
            <Callout tone="warn" title={t("v4.subscription.legacyEndMissingTitle")}>
              {t("v4.subscription.legacyEndMissingBody")}
            </Callout>
          )}

          <Card className="overflow-hidden rounded-[22px] border border-edge-subtle bg-surface shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-edge-subtle px-6 py-5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-ink-3">
                  <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                  <span>
                    {t(
                      workspace.summary.status === "active"
                        ? "v4.subscription.yourCurrentPlan"
                        : "v4.subscription.recordedContract",
                    )}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-baseline gap-3">
                  <h2 className="text-xl font-semibold tracking-tight text-ink">
                    {workspace.summary.planName}
                  </h2>
                  {workspace.summary.publishedPrice && (
                    <span className="text-sm tabular-nums text-ink-3">
                      <bdi dir="auto">{workspace.summary.publishedPrice}</bdi>
                    </span>
                  )}
                </div>
              </div>
              <StatusBadge tone={workspace.summary.tone} label={workspace.summary.statusLabel} />
            </div>

            <dl className="grid gap-4 px-6 py-5 sm:grid-cols-2 lg:grid-cols-4">
              {[
                [t("v4.subscription.type"), workspace.summary.typeLabel],
                [t("v4.onboarding.term"), workspace.summary.termLabel],
                [t("v4.subscription.start"), workspace.summary.startDateLabel],
                [t("v4.subscription.end"), workspace.summary.endDateLabel],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl bg-surface-2/60 px-4 py-3">
                  <dt className="text-xs text-ink-3">{label}</dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-ink">
                    <bdi dir="auto">{value}</bdi>
                  </dd>
                </div>
              ))}
            </dl>

            {workspace.summary.usage && workspace.summary.usage.limit !== "unlimited" && (
              <div className="border-t border-edge-subtle px-6 py-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
                  <span>{t("v4.subscription.monthlyUsage")}</span>
                  <span className="tabular-nums font-medium text-ink-2" dir="ltr">
                    {formatNumber(workspace.summary.usage.used)} / {formatNumber(workspace.summary.usage.limit)}
                  </span>
                </div>
                <Progress
                  value={Math.min(100, (workspace.summary.usage.used / Math.max(1, workspace.summary.usage.limit)) * 100)}
                  tone={workspace.summary.usage.remaining === 0 ? "bad" : "brand"}
                  label={t("billing.usageAria", {
                    used: formatNumber(workspace.summary.usage.used),
                    limit: formatNumber(workspace.summary.usage.limit),
                  })}
                />
                <p className="mt-2 text-xs tabular-nums text-ink-3">
                  {t("v4.subscription.nextReset", { date: workspace.summary.usage.resetLabel })}
                </p>
              </div>
            )}

            <div className="border-t border-edge-subtle bg-surface-2/35 px-6 py-3 text-xs text-ink-3">
              {workspace.summary.renewalNote}
            </div>
          </Card>
        </section>
      )}

      {/* Segmented Monthly / Yearly Toggle */}
      <section className="space-y-6">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="text-center sm:text-start">
              <h2 className="text-xl font-semibold tracking-tight text-ink">
                {t(mode === "workspace" ? "billing.comparePlans" : "v4.pricing.eyebrow")}
              </h2>
            </div>

            <div
              role="group"
              aria-label={t("v4.onboarding.term")}
              className="inline-flex items-center rounded-full border border-edge-subtle bg-surface-2 p-1 shadow-xs"
            >
              <button
                type="button"
                aria-pressed={term === "monthly"}
                onClick={() => setTerm("monthly")}
                className={`min-h-9 rounded-full px-4 text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 ${
                  term === "monthly"
                    ? "bg-surface text-ink shadow-xs"
                    : "text-ink-3 hover:text-ink"
                }`}
              >
                {t("v4.onboarding.monthly")}
              </button>
              <button
                type="button"
                aria-pressed={term === "yearly"}
                onClick={() => setTerm("yearly")}
                className={`inline-flex min-h-9 items-center gap-2 rounded-full px-4 text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 ${
                  term === "yearly"
                    ? "bg-surface text-ink shadow-xs"
                    : "text-ink-3 hover:text-ink"
                }`}
              >
                <span>{t("v4.onboarding.yearly")}</span>
                <span className="rounded-full bg-ok-bg px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ok" dir="ltr">
                  -{ANNUAL_DISCOUNT_PERCENT}%
                </span>
              </button>
            </div>
          </div>

          {usingFallbackCatalog && (
            <p className="text-center text-xs text-ink-3 sm:text-start">
              {t("pricing.noPlansBody")}
            </p>
          )}

          {/* Three Apple-minimal plan cards */}
          <div className="grid gap-5 md:grid-cols-3">
            {plans.map((plan, index) => {
              const price = formatPlanTermPriceDisplay(plan.priceMinorUnits, plan.priceCurrency, term, locale);
              const eligibility =
                mode === "workspace" && workspace && !plan.isFallback
                  ? evaluatePlanChangeEligibility({
                      status: workspace.summary.status,
                      currentPlanId: workspace.summary.planId,
                      currentTerm: workspace.currentTerm,
                      targetPlanId: plan.id,
                      targetTerm: term,
                      expiringSoon: workspace.summary.expiringSoon,
                      pendingRequest: activePendingRequest,
                    })
                  : null;

              const isCurrentActive =
                mode === "workspace" &&
                workspace?.summary.status === "active" &&
                workspace.summary.planId === plan.id &&
                !plan.isFallback;
              const isPendingThisCard = eligibility?.reason === "pending_same_request";
              const isFeatured =
                (mode === "public" && index === featuredIndex) ||
                (mode === "workspace" && !workspace?.summary.planId && index === featuredIndex);

              const maxAgents = entitlementLimitText(plan.entitlements.max_agents, formatNumber, t("billing.unlimited"));
              const maxPrinters = entitlementLimitText(plan.entitlements.max_printers, formatNumber, t("billing.unlimited"));

              const currentTermSuffix =
                workspace?.currentTerm === "yearly"
                  ? t("v4.onboarding.yearly")
                  : workspace?.currentTerm === "monthly"
                    ? t("v4.onboarding.monthly")
                    : "";
              const currentPlanBadgeLabel = currentTermSuffix
                ? [t("pricing.currentPlan"), currentTermSuffix].join(" · ")
                : t("pricing.currentPlan");

              const cardStyle = isCurrentActive
                ? "border-ok/50 bg-ok-bg/10 shadow-md ring-2 ring-ok/20"
                : isPendingThisCard
                  ? "border-warn/45 bg-surface shadow-md ring-1 ring-warn/20"
                  : isFeatured
                    ? "border-brand/45 bg-surface shadow-md ring-1 ring-brand/15"
                    : "border-edge-subtle bg-surface shadow-sm hover:border-edge-strong";

              const isSubmittingThis = submittingPlanId === plan.id;
              const isActionDisabled =
                !workspace?.isOwner ||
                plan.isFallback ||
                submittingPlanId !== null ||
                (eligibility ? !eligibility.allowed : false);

              let workspaceButtonLabel = t("billing.planAction.requestPlan");
              let workspaceButtonIcon: React.ReactNode = <ArrowRight className="h-4 w-4 rtl:-scale-x-100" />;
              let workspaceButtonVariant: "primary" | "secondary" = isFeatured ? "primary" : "secondary";

              if (isSubmittingThis) {
                workspaceButtonLabel = t("billing.planAction.submitting");
                workspaceButtonIcon = undefined;
                workspaceButtonVariant = "primary";
              } else if (eligibility?.reason === "already_active") {
                workspaceButtonLabel = t("billing.planAction.currentPlan");
                workspaceButtonIcon = <Check className="h-4 w-4" />;
                workspaceButtonVariant = "secondary";
              } else if (eligibility?.reason === "already_on_yearly") {
                workspaceButtonLabel = t("billing.planAction.alreadyOnYearly");
                workspaceButtonIcon = <Check className="h-4 w-4" />;
                workspaceButtonVariant = "secondary";
              } else if (eligibility?.reason === "pending_same_request") {
                workspaceButtonLabel = t("billing.planAction.pendingThisPlan");
                workspaceButtonIcon = <Clock className="h-4 w-4" />;
                workspaceButtonVariant = "secondary";
              } else if (eligibility?.reason === "pending_other_request") {
                workspaceButtonLabel = t("billing.planAction.pendingOtherRequest");
                workspaceButtonIcon = <Clock className="h-4 w-4" />;
                workspaceButtonVariant = "secondary";
              } else if (eligibility?.action === "upgrade_to_yearly") {
                workspaceButtonLabel = t("billing.planAction.upgradeToYearly", {
                  percent: ANNUAL_DISCOUNT_PERCENT,
                });
                workspaceButtonIcon = <Sparkles className="h-4 w-4" />;
                workspaceButtonVariant = "primary";
              } else if (eligibility?.action === "renew") {
                workspaceButtonLabel = t("v4.subscription.renewRequestAction");
                workspaceButtonIcon = <ArrowRight className="h-4 w-4 rtl:-scale-x-100" />;
                workspaceButtonVariant = "primary";
              } else if (eligibility?.allowed) {
                workspaceButtonVariant = isFeatured || workspace?.summary.status === "active" ? "primary" : "secondary";
              }

              return (
                <Card
                  key={plan.id}
                  data-current-plan={isCurrentActive ? "true" : undefined}
                  className={`flex h-full flex-col overflow-hidden rounded-[24px] border transition-all duration-200 ${cardStyle}`}
                >
                  <div className="flex flex-1 flex-col p-6">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-lg font-semibold tracking-tight text-ink">{plan.name}</h3>
                      {isCurrentActive ? (
                        <StatusBadge
                          tone="ok"
                          label={currentPlanBadgeLabel}
                          size="sm"
                        />
                      ) : isPendingThisCard ? (
                        <StatusBadge tone="warn" label={t("billing.planAction.pendingThisPlan")} size="sm" />
                      ) : isFeatured ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-brand-subtle px-2.5 py-0.5 text-xs font-medium text-brand-subtle-text">
                          <Sparkles className="h-3 w-3" aria-hidden />
                          {t("v4.pricing.eyebrow")}
                        </span>
                      ) : null}
                    </div>

                    {plan.description && (
                      <p className="mt-2 min-h-[2.75rem] text-sm leading-relaxed text-ink-3">
                        {plan.description}
                      </p>
                    )}

                    {/* Price Display */}
                    <div className="mt-5 min-h-[5.25rem] border-t border-edge-subtle pt-5">
                      {price ? (
                        <>
                          <div className="inline-flex max-w-full items-baseline gap-1.5" dir="ltr">
                            <span className="text-[clamp(1.85rem,2.6vw,2.35rem)] font-bold leading-none tracking-[-0.03em] tabular-nums text-ink">
                              {price.effectiveMonthly.amount}
                            </span>
                            <span className="text-xs font-semibold uppercase tracking-wide text-ink-3">
                              {price.effectiveMonthly.currency}
                            </span>
                            <span className="text-xs text-ink-3">/ {t("v4.onboarding.monthly")}</span>
                          </div>
                          {term === "yearly" && price.computed.billedAmountMinorUnits > 0 ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                              <span className="tabular-nums" dir="ltr">
                                {price.billedTotal.amount} {price.billedTotal.currency} / {t("v4.onboarding.yearly")}
                              </span>
                              {price.yearlySavings && (
                                <span className="rounded-full bg-ok-bg px-2 py-0.5 font-semibold tabular-nums text-ok" dir="ltr">
                                  -{price.yearlySavings.amount} {price.yearlySavings.currency}
                                </span>
                              )}
                            </div>
                          ) : (
                            <p className="mt-2 text-xs text-ink-3">{t("v4.pricing.publishedPrice")}</p>
                          )}
                        </>
                      ) : (
                        <p className="pt-2 text-lg font-semibold text-ink-2">
                          {t("v4.pricing.priceOnRequest")}
                        </p>
                      )}
                    </div>

                    {/* Concise Licensing Features */}
                    <ul className="mt-5 space-y-2.5 border-t border-edge-subtle pt-5 text-sm text-ink-2">
                      {maxAgents && (
                        <li className="flex items-center gap-2.5">
                          <Check className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                          <span>
                            {t("billing.entitlement.max_agents")}:{" "}
                            <strong className="font-semibold tabular-nums text-ink">
                              <bdi dir="ltr">{maxAgents}</bdi>
                            </strong>
                          </span>
                        </li>
                      )}
                      {maxPrinters && (
                        <li className="flex items-center gap-2.5">
                          <Check className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                          <span>
                            {t("billing.entitlement.max_printers")}:{" "}
                            <strong className="font-semibold tabular-nums text-ink">
                              <bdi dir="ltr">{maxPrinters}</bdi>
                            </strong>
                          </span>
                        </li>
                      )}
                      {(["v4.pricing.featureOdoo", "v4.pricing.featureBranches"] as const).map(key => (
                        <li key={key} className="flex items-center gap-2.5">
                          <Check className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                          <span>{t(key)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Card Action */}
                  <div className="mt-auto border-t border-edge-subtle px-6 py-5">
                    {mode === "public" ? (
                      <Button
                        href={publicDestination(plan)}
                        variant={isFeatured ? "primary" : "secondary"}
                        size="md"
                        className="w-full"
                        icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
                      >
                        {t(publicRole === "member" ? "pricing.openConsole" : "pricing.chooseThisPlan")}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant={workspaceButtonVariant}
                        size="md"
                        className="w-full"
                        disabled={isActionDisabled}
                        loading={isSubmittingThis}
                        icon={workspaceButtonIcon}
                        onClick={() => void submitPlanCardRequest(plan)}
                      >
                        {workspaceButtonLabel}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
      </section>

      {/* Workspace Request Status & Manual Billing Controls */}
      {mode === "workspace" && workspace && (
        <Card className="rounded-[22px] border border-edge-subtle bg-surface shadow-sm">
          <div className="p-6">
            <BillingActions
              key={`${workspace.selectedPlanId ?? ""}:${workspace.initialRequest?.id ?? "none"}:${workspace.initialRequest?.status ?? "none"}`}
              plans={workspace.requestPlans}
              selectedPlanId={workspace.selectedPlanId}
              currentPlanId={workspace.summary.planId}
              currentTerm={workspace.currentTerm}
              controlledTerm={term}
              onTermChange={setTerm}
              externalRequest={liveRequest}
              onRequestCreated={(req) => {
                setLiveRequest(req);
                const planName = plans.find(p => p.id === req.planId)?.name ?? req.planId;
                showRequestSentToast(planName, req.term, req.reference);
              }}
              isOwner={workspace.isOwner}
              status={workspace.summary.status}
              expiringSoon={workspace.summary.expiringSoon}
              initialRequest={workspace.initialRequest}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
