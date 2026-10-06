import { cookies } from "next/headers";
import { getServerLocale, makeT } from "../../i18n/server";
import type { MessageKey } from "../../i18n/messages/en";
import { formatDate as formatDateI18n, formatNumber } from "../../i18n/format";
import type { Locale } from "../../i18n/config";
import { redirect } from "next/navigation";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import { BillingActions } from "../../components/BillingActions";
import { AlertTriangle, ArrowRight, CalendarDays, Check, CreditCard, Receipt } from "lucide-react";
import Link from "next/link";
import {
  Button,
  Callout,
  Card,
  CardHeader,
  PageContainer,
  PageHeader,
  Progress,
  StatusBadge,
  type Tone,
} from "../../components/ui";
import { getTenantPrintUsage } from "../../lib/entitlements";
import { logWarn } from "../../lib/log";
import type { Translator } from "../../i18n/translate";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ checkout?: string | string[]; plan?: string | string[] }>;
type SubscriptionRow = typeof tenantSubscriptions.$inferSelect;


function entitlementLabel(value: string, t: Translator) {
  if (value === "max_prints_per_period") return t("billing.printJobsPerPeriod");
  return value.replace(/^max_/, "").replace(/_/g, " ");
}

function entitlementValue(value: unknown, t: Translator, locale: Locale) {
  if (value === "unlimited") return t("billing.unlimited");
  if (typeof value === "boolean") return value ? t("billing.included") : "—";
  if (typeof value === "number") return formatNumber(value, locale);
  return String(value);
}

function planStatus(
  sub: SubscriptionRow,
  t: Translator,
  formatDate: (value: Date) => string,
) {
  const end = sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : null;
  if (sub.status === "trialing") {
    return {
      tone: "brand" as const,
      label: t("billing.trial"),
      message: end
        ? sub.stripeSubscriptionId
          ? t("billing.trialEnds", { date: end })
          : t("billing.trialEndsNoSubscription", { date: end })
        : t("billing.trialBody"),
    };
  }
  if (sub.status === "active") {
    return {
      tone: "ok" as const,
      label: t("billing.active"),
      message: sub.cancelAtPeriodEnd && end ? t("billing.cancelScheduled", { date: end }) : end ? t("billing.renewsOn", { date: end }) : t("billing.activeBody"),
    };
  }
  if (sub.status === "past_due") {
    return {
      tone: "warn" as const,
      label: t("billing.paymentAttention"),
      message: t("billing.stripeRetrying"),
    };
  }
  if (sub.status === "unpaid") {
    return { tone: "bad" as const, label: t("billing.paymentRequired"), message: t("billing.unpaidBody") };
  }
  if (sub.status === "paused") {
    return { tone: "warn" as const, label: t("billing.paused"), message: t("billing.pausedBody") };
  }
  if (sub.status === "incomplete") {
    return { tone: "warn" as const, label: t("billing.paymentRequired"), message: t("billing.incompleteBody") };
  }
  if (sub.status === "incomplete_expired") {
    return { tone: "bad" as const, label: t("billing.checkoutExpired"), message: t("billing.incompleteExpiredBody") };
  }
  return { tone: "neutral" as const, label: t("billing.canceled"), message: t("billing.canceledBody") };
}

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get("cust_session")?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );
  if (!claims) redirect("/login");
  if (!hasManagerPermission(claims, "billing.read")) redirect("/dashboard");

  const locale = await getServerLocale();
  const t = makeT(locale);
  const formatDate = (value: Date) => formatDateI18n(value, locale);
  const params = await searchParams;
  const checkoutState = typeof params.checkout === "string" ? params.checkout : undefined;
  const selectedPlanId = typeof params.plan === "string" ? params.plan : undefined;

  const sub = await db.query.tenantSubscriptions.findFirst({
    where: eq(tenantSubscriptions.tenantId, claims.tenantId),
  });

  const currentPlan = sub
    ? await db.query.plans.findFirst({
        where: eq(plans.id, sub.planId),
        columns: { id: true, name: true, description: true, currency: true, interval: true, entitlements: true },
      })
    : null;

  let printUsage: Awaited<ReturnType<typeof getTenantPrintUsage>> | null = null;
  let printUsageUnavailable = false;
  if (sub) {
    try {
      printUsage = await getTenantPrintUsage(db, claims.tenantId);
    } catch (error) {
      printUsageUnavailable = true;
      // Never pass a live Error: JSON.stringify(Error) → {} loses the message.
      logWarn("billing.print_usage_unavailable", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const availablePlans = await db
    .select({
      id: plans.id,
      name: plans.name,
      description: plans.description,
      entitlements: plans.entitlements,
      currency: plans.currency,
      interval: plans.interval,
      displayOrder: plans.displayOrder,
    })
    .from(plans)
    .where(and(eq(plans.isActive, true), eq(plans.isPublic, true)))
    .orderBy(asc(plans.displayOrder), asc(plans.name));

  const selectedPlan = selectedPlanId ? availablePlans.find((item) => item.id === selectedPlanId) ?? null : null;
  const activeStatuses = new Set(["trialing", "active", "past_due"]);
  const hasActivePlan = !!sub && activeStatuses.has(sub.status);
  const hasStripeSubscription = !!sub?.stripeCustomerId && !!sub.stripeSubscriptionId;
  const status = sub ? planStatus(sub, t, formatDate) : null;
  const entitlements = currentPlan?.entitlements
    ? Object.entries(currentPlan.entitlements)
        .filter(([, value]) => value !== false)
        .slice(0, 8)
        .map(([key, value]) => ({ label: entitlementLabel(key, t), value: entitlementValue(value, t, locale) }))
    : [];

  const renewalLabel = !sub
    ? t("billing.noRenewalDate")
    : sub.status === "cancelled"
      ? sub.currentPeriodEnd
        ? `Ended ${formatDate(sub.currentPeriodEnd)}`
        : t("billing.ended")
      : sub.cancelAtPeriodEnd && sub.currentPeriodEnd
        ? `Ends ${formatDate(sub.currentPeriodEnd)}`
        : sub.currentPeriodEnd
          ? `Renews ${formatDate(sub.currentPeriodEnd)}`
          : t("billing.noRenewalDate");

  const usagePct =
    printUsage && printUsage.limit !== "unlimited"
      ? Math.min(100, Math.max(0, (printUsage.used / Math.max(1, printUsage.limit)) * 100))
      : 0;
  const usageTone: Tone = printUsage && printUsage.limit !== "unlimited"
    ? printUsage.remaining === 0
      ? "bad"
      : usagePct >= 85
        ? "warn"
        : "brand"
    : "brand";

  const attentionStatuses = ["unpaid", "paused", "incomplete"];

  return (
    <>
      <PageHeader
        eyebrow={t("billing.eyebrow")}
        icon={<CreditCard className="h-4 w-4" />}
        title={t("nav.billing")}
        description={t("billing.pageDescription")}
        meta={status ? <StatusBadge tone={status.tone} label={status.label} /> : <StatusBadge tone="neutral" label={t("billing.noPlan")} />}
        actions={
          <>
            {hasStripeSubscription && (
              <Button variant="ghost" size="sm" href="#billing-actions" icon={<Receipt className="h-4 w-4" />}>
                {t("billing.manageBilling")}
              </Button>
            )}
            <Button variant="primary" size="sm" href="/pricing" icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}>
              {hasActivePlan ? t("billing.upgradePlan") : t("billing.viewPlans")}
            </Button>
          </>
        }
      />

      <PageContainer>
        <div className="space-y-5">
          {checkoutState === "success" && (
            <Callout tone="ok" title={t("billing.checkoutCompleted")}>
              {t("billing.paymentReceivedBody")}
            </Callout>
          )}
          {checkoutState === "cancelled" && (
            <Callout tone="neutral" title={t("billing.checkoutCancelled")}>
              {t("billing.checkoutCancelledBody")}
            </Callout>
          )}
          {sub && (sub.checkoutStatus === "creating" || sub.checkoutStatus === "open") && checkoutState !== "success" && checkoutState !== "cancelled" && (
            <Callout tone="info" title={t("billing.checkoutInProgress")}>
              {t("billing.paymentPendingBody")}
            </Callout>
          )}
          {printUsageUnavailable && (
            <Callout tone="warn" title={t("billing.usageUnavailable")}>
              {t("billing.usageUnavailableBody")}
            </Callout>
          )}

          {selectedPlan && selectedPlan.id !== currentPlan?.id && (
            <BillingActions
              hasSubscription={hasActivePlan && hasStripeSubscription}
              cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd}
              subscriptionStatus={sub?.status}
              canOpenPortal={hasStripeSubscription}
              checkoutUrl={sub?.checkoutSessionUrl}
              selectedPlan={selectedPlan}
            />
          )}

          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(300px,320px)]">
            <div className="space-y-5">
              <section className="card overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5">
                  <div className="min-w-0">
                    <div className="label-caps">{t("billing.currentPlan")}</div>
                    <h2 className="mt-2 text-3xl font-[660] tracking-[-0.035em] text-ink">
                      {currentPlan?.name ?? t("billing.noPlanSelected")}
                    </h2>
                    <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-ink-3">
                      {currentPlan?.description || status?.message || t("billing.choosePlanToActivate")}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                    <Button variant="primary" href="/pricing" icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}>
                      {hasActivePlan ? t("billing.upgradePlan") : t("billing.choosePlan")}
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 divide-y divide-edge-subtle border-y border-edge-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                  <div className="px-5 py-4">
                    <div className="label-caps">{t("billing.subscriptionStatus")}</div>
                    <div className="mt-1.5 text-sm font-[600] text-ink">
                      {status ? status.label : t("billing.notConfigured")}
                    </div>
                  </div>
                  <div className="px-5 py-4">
                    <div className="label-caps">{t("billing.billingCycle")}</div>
                    <div className="mt-1.5 flex items-center gap-2 text-sm font-[600] capitalize text-ink">
                      <CalendarDays className="h-4 w-4 text-ink-4" aria-hidden />
                      {currentPlan?.interval ?? "—"}
                    </div>
                  </div>
                  <div className="px-5 py-4">
                    <div className="label-caps">{t("billing.renewal")}</div>
                    <div className="mt-1.5 text-sm font-[600] text-ink">{renewalLabel}</div>
                  </div>
                </div>

                <div className="px-5 py-5">
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <h3 className="text-md font-[600] tracking-[-0.015em] text-ink">
                      {t("billing.whatThisPlanCovers")}
                    </h3>
                    <Link
                      href="/pricing"
                      className="inline-flex items-center gap-1.5 text-sm font-[550] text-brand transition-colors hover:text-brand-hover"
                    >
                      {t("billing.comparePlans")} <ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
                    </Link>
                  </div>

                  {entitlements.length > 0 ? (
                    <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                      {entitlements.map((entry) => (
                        <li key={entry.label} className="rounded-sg border border-edge bg-surface-2 px-4 py-3.5">
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-xs bg-ok-bg text-ok" aria-hidden>
                              <Check className="h-3 w-3" />
                            </span>
                            <div className="min-w-0">
                              <div className="text-xs capitalize text-ink-3">{entry.label}</div>
                              <div className="mt-0.5 text-base font-[620] tabular text-ink">{entry.value}</div>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-4 rounded-sg border border-dashed border-edge-strong bg-surface-2 px-4 py-5 text-sm text-ink-3">
                      {t("billing.capacityManagedBody")}
                    </p>
                  )}
                </div>
              </section>

              {printUsage && (
                <Card>
                  <CardHeader
                    title={t("billing.printUsage")}
                    subtitle={t("billing.printUsageSubtitle")}
                    icon={<CreditCard className="h-4 w-4" />}
                    actions={
                      printUsage.limit !== "unlimited" ? (
                        <StatusBadge
                          tone={usageTone}
                          label={printUsage.remaining === 0 ? t("billing.limitReached") : typeof printUsage.remaining === "number" ? t("billing.remaining", { count: formatNumber(printUsage.remaining, locale) }) : t("billing.unlimited")}
                        />
                      ) : (
                        <StatusBadge tone="ok" label={t("billing.unlimited")} />
                      )
                    }
                  />
                  <div className="px-5 py-5">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                      <div className="text-2xl font-[640] leading-none tracking-[-0.02em] text-ink tabular">
                        {formatNumber(printUsage.used, locale)}
                        {printUsage.limit !== "unlimited" && (
                          <span className="text-ink-4"> / {formatNumber(printUsage.limit, locale)}</span>
                        )}
                      </div>
                      <div className="text-xs text-ink-3">
                        {printUsage.periodEnd ? t("billing.periodEndsOn", { date: formatDate(printUsage.periodEnd) }) : t("billing.currentPeriod")}
                      </div>
                    </div>
                    {printUsage.limit !== "unlimited" && (
                      <Progress
                        className="mt-3"
                        value={usagePct}
                        tone={usageTone}
                        label={t("billing.usageAria", { used: formatNumber(printUsage.used, locale), limit: formatNumber(printUsage.limit, locale) })}
                      />
                    )}
                    {printUsage.remaining === 0 && (
                      <p className="mt-3 text-sm font-[550] text-bad">{t("billing.creditsExhausted")}</p>
                    )}
                  </div>
                </Card>
              )}

              {sub && (attentionStatuses.includes(sub.status) || sub.status === "past_due" || (sub.cancelAtPeriodEnd && sub.status === "active" && sub.currentPeriodEnd)) && (
                <div className="space-y-3">
                  {sub.status === "past_due" && <WarnLine text={t("billing.warnPastDue")} />}
                  {sub.status === "unpaid" && <WarnLine text={t("billing.warnUnpaid")} />}
                  {sub.status === "paused" && <WarnLine text={t("billing.warnPaused")} />}
                  {sub.status === "incomplete" && <WarnLine text={t("billing.warnIncomplete")} />}
                  {sub.cancelAtPeriodEnd && sub.status === "active" && sub.currentPeriodEnd && <WarnLine text={t("billing.warnCancelScheduled", { date: formatDate(sub.currentPeriodEnd) })} />}
                </div>
              )}
            </div>

            <aside className="space-y-5">
              <Card id="billing-actions">
                <CardHeader
                  title={t("billing.controls")}
                  subtitle={t("billing.controlsSubtitle")}
                  icon={<Receipt className="h-4 w-4" />}
                />
                <div className="px-5 py-5">
                  <BillingActions
                    hasSubscription={hasActivePlan && hasStripeSubscription}
                    cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd}
                    subscriptionStatus={sub?.status}
                    canOpenPortal={hasStripeSubscription}
                    checkoutUrl={sub?.checkoutSessionUrl}
                  />
                </div>
              </Card>

              <Card>
                <CardHeader title={t("billing.howChargingWorks")} icon={<CreditCard className="h-4 w-4" />} />
                <ul className="space-y-3 px-5 py-5 text-sm text-ink-2">
                  <li className="flex gap-2.5">
                    <span className="mt-1.5"><span className="status-dot bg-ink-4" /></span>
                    <span>{t("billing.howChargingStripe")}</span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="mt-1.5"><span className="status-dot bg-ink-4" /></span>
                    <span>{t("billing.howChargingProrated")}</span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="mt-1.5"><span className="status-dot bg-ink-4" /></span>
                    <span>{t("billing.howChargingCredits")}</span>
                  </li>
                </ul>
              </Card>
            </aside>
          </div>
        </div>
      </PageContainer>
    </>
  );
}

function WarnLine({ text }: { text: string }) {
  return (
    <Callout tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
      {text}
    </Callout>
  );
}
