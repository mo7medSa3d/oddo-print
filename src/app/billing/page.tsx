import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { CreditCard } from "lucide-react";
import { db } from "../../db";
import { plans } from "../../db/schema";
import { sessionCookieName } from "../../lib/session-config";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import { customerSubscriptionState } from "../../lib/manual-subscriptions";
import { databaseNowMs } from "../../lib/database-clock";
import { activationWhatsAppUrl } from "../../lib/activation-contact";
import { getServerLocale, makeT } from "../../i18n/server";
import { intlLocale } from "../../i18n/config";
import { formatManualCalendarDate } from "../../lib/manual-calendar-date";
import { billingTermLabel } from "../../lib/billing-labels";
import { formatPlanPrice, resolveThreePlanCatalog, type BillingTerm } from "../../lib/plan-price";
import { UnifiedBillingView } from "../../components/UnifiedBillingView";
import { PageContainer, PageHeader, StatusBadge, type Tone } from "../../components/ui";
import { loadOwnerBillingPageSnapshot } from "../../lib/billing-page-snapshot";
import { ManagerMutationAuthorityChangedError } from "../../lib/manager-mutation-authorization";
import { TenantSuspendedError, TenantDeletedError } from "../../lib/tenant-guard";

export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[]; term?: string | string[] }>;
}) {
  const jar = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    jar.get(sessionCookieName("customer"))?.value ?? null,
    jar.get(getManagerCookieName())?.value ?? null,
  );
  if (!claims) redirect("/login?next=%2Fbilling");
  if (!claims.userId || !hasManagerPermission(claims, "billing.read")) redirect("/dashboard");

  const locale = await getServerLocale();
  const t = makeT(locale);
  const params = await searchParams;

  const [availablePlans, now] = await Promise.all([
    db
      .select({
        id: plans.id,
        name: plans.name,
        description: plans.description,
        priceMinorUnits: plans.priceMinorUnits,
        priceCurrency: plans.priceCurrency,
        entitlements: plans.entitlements,
      })
      .from(plans)
      .where(and(eq(plans.isActive, true), eq(plans.isPublic, true)))
      .orderBy(asc(plans.displayOrder), asc(plans.name)),
    databaseNowMs(),
  ]);

  let snapshot: Awaited<ReturnType<typeof loadOwnerBillingPageSnapshot>>;
  try {
    // SSR is a data disclosure boundary too. Cookie preflight alone must not
    // expose the former owner's contract after a logout, role downgrade or
    // workspace suspension. The snapshot keeps the current authority locks
    // held until its subscription, history and monthly-usage reads finish.
    snapshot = await loadOwnerBillingPageSnapshot(claims);
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) {
      if (error.status === 401) redirect("/login?next=%2Fbilling");
      redirect("/dashboard");
    }
    if (error instanceof TenantSuspendedError || error instanceof TenantDeletedError) {
      redirect("/dashboard");
    }
    throw error;
  }

  const { sub, tenant, requests, plan, usage } = snapshot;
  const status = customerSubscriptionState(sub, tenant?.lifecycle, now);
  // Published list price is not the manually agreed price of this subscription.
  const publishedPlanPrice =
    sub?.subscriptionType === "paid" && plan
      ? formatPlanPrice(plan.priceMinorUnits, plan.priceCurrency, locale)
      : null;

  const statusKey = {
    active: "v4.onboarding.active",
    awaiting_activation: "v4.onboarding.pending",
    expired: "v4.onboarding.expired",
    suspended: "v4.onboarding.suspended",
  } as const;
  const tone: Tone = status === "active" ? "ok" : status === "suspended" ? "bad" : "warn";

  const date = (value: Date | null | undefined) =>
    formatManualCalendarDate(value, locale) ?? t("v4.subscription.notSet");
  const resetInstant = (value: Date | null | undefined) =>
    value
      ? new Intl.DateTimeFormat(intlLocale(locale), {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "UTC",
        })
          .format(value)
          .replaceAll("\u200f", "")
      : t("v4.subscription.notSet");

  const quotaExhausted = status === "active" && usage?.remaining === 0;
  const expiringSoon =
    status === "active" &&
    !!sub?.currentPeriodEnd &&
    sub.currentPeriodEnd.getTime() > now &&
    sub.currentPeriodEnd.getTime() - now <= 7 * 86_400_000;
  const legacyEndMissing =
    status === "expired" && sub?.status === "active" && sub?.subscriptionType === "paid" && !sub.currentPeriodEnd;
  const request = requests[0];
  const selectedPlanId = typeof params.plan === "string" ? params.plan : undefined;
  const initialTerm: BillingTerm | undefined =
    params.term === "yearly" ? "yearly" : params.term === "monthly" ? "monthly" : undefined;

  const catalog = resolveThreePlanCatalog(availablePlans);

  return (
    <>
      <PageHeader
        title={t("v4.subscription.title")}
        icon={<CreditCard className="h-4 w-4" />}
        meta={<StatusBadge tone={tone} label={t(statusKey[status])} />}
      />
      <PageContainer>
        <UnifiedBillingView
          mode="workspace"
          plans={catalog.plans}
          usingFallbackCatalog={catalog.usingFallback}
          workspace={{
            isOwner: claims.role === "owner",
            selectedPlanId,
            initialTerm,
            currentTerm: sub?.term,
            summary: {
              status,
              statusLabel: t(statusKey[status]),
              tone,
              planId: sub?.planId ?? null,
              planName: plan?.name ?? t("billing.noPlanSelected"),
              publishedPrice: publishedPlanPrice,
              typeLabel: t(
                sub?.subscriptionType === "free"
                  ? "v4.subscription.free"
                  : sub?.subscriptionType === "paid"
                    ? "v4.subscription.paid"
                    : "v4.subscription.notSet",
              ),
              termLabel: billingTermLabel(sub?.term, t),
              startDateLabel: date(sub?.currentPeriodStart),
              endDateLabel: date(sub?.currentPeriodEnd),
              renewalNote: t(sub?.cancelAtPeriodEnd ? "v4.subscription.endsAtTerm" : "v4.subscription.manualRenewal"),
              quotaExhausted,
              expiringSoon,
              expiringSoonDate: date(sub?.currentPeriodEnd),
              legacyEndMissing,
              usage: usage
                ? {
                    used: usage.used,
                    limit: usage.limit,
                    remaining: usage.remaining,
                    resetLabel: resetInstant(usage.reset),
                  }
                : null,
            },
            requestPlans: availablePlans,
            initialRequest: request
              ? {
                  id: request.id,
                  reference: request.id,
                  status: request.status,
                  planId: request.planId,
                  term: request.term,
                  requestedMonthlyQuota: request.requestedMonthlyQuota,
                  approvalModified: request.approvalModified,
                  approvedPlanId: request.approvedPlanId,
                  approvedTerm: request.approvedTerm,
                  approvedMonthlyQuota: request.approvedMonthlyQuota,
                  createdAt: request.createdAt.toISOString(),
                  whatsappUrl: activationWhatsAppUrl(request.id),
                }
              : null,
          }}
        />
      </PageContainer>
    </>
  );
}
