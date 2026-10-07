import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { billingIntervalLabel } from "../../lib/billing-labels";
import { ArrowRight, Check, CreditCard, DatabaseZap, Receipt } from "lucide-react";
import { Button, Callout, Card, StatusBadge } from "../../components/ui";
import { BrandMark } from "../../components/brand";
import { ThemeToggle } from "../../components/ThemeToggle";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";
import { logError } from "../../lib/log";
import { getServerLocale, makeT } from "../../i18n/server";
import type { MessageKey } from "../../i18n/messages/en";
import { formatNumber as formatNumberFor } from "../../i18n/format";
import type { Translator } from "../../i18n/translate";

export const dynamic = "force-dynamic";

const ENTITLEMENT_KEYS: Record<string, MessageKey> = {
  max_prints_per_period: "pricing.entitlement.prints",
  max_agents: "pricing.entitlement.agents",
  max_printers: "pricing.entitlement.printers",
  max_jobs_per_minute: "pricing.entitlement.jobsPerMinute",
  max_concurrent_jobs: "pricing.entitlement.concurrentJobs",
};

function entitlementLabel(
  value: string,
  t: Translator,
): string {
  const key = ENTITLEMENT_KEYS[value];
  if (key) return t(key);
  return value.replace(/^max_/, "").replace(/_/g, " ");
}

function entitlementValue(
  value: unknown,
  t: Translator,
  formatNumber: (value: number) => string,
): string {
  if (value === "unlimited") return t("pricing.unlimited");
  if (typeof value === "boolean") return value ? t("pricing.included") : t("pricing.notIncluded");
  if (typeof value === "number") return formatNumber(value);
  return String(value);
}

export default async function Pricing() {
  let rows: Array<{
    id: string;
    name: string;
    description: string | null;
    entitlements: unknown;
    currency: string | null;
    interval: string | null;
    displayOrder: number;
  }> = [];
  let catalogUnavailable = false;

  try {
    rows = await db
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
      .where(and(isNotNull(plans.stripePriceId), eq(plans.isActive, true), eq(plans.isPublic, true)))
      .orderBy(asc(plans.displayOrder), asc(plans.name));
  } catch (error: unknown) {
    // The catalog is the only thing this page needs from the database. If it is
    // unreachable the page still renders, with an explicit unavailable state
    // instead of an empty catalog that looks like "no plans exist".
    logError("pricing.catalog_load_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    catalogUnavailable = true;
  }

  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get("cust_session")?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );

  let currentPlanId: string | null = null;

  if (claims && !catalogUnavailable) {
    const subscription = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, claims.tenantId),
    });
    // Only a live subscription marks a plan current: a cancelled/expired row
    // is history and must not badge its plan as "current" (C055).
    if (subscription && (subscription.status === "trialing" || subscription.status === "active" || subscription.status === "past_due")) {
      currentPlanId = subscription.planId;
    }
  }

  const locale = await getServerLocale();
  const t = makeT(locale);
  const formatNumber = (value: number) => formatNumberFor(value, locale);
  const destination = (planId: string) => claims ? `/billing?plan=${encodeURIComponent(planId)}` : `/signup?plan=${encodeURIComponent(planId)}`;
  const columns = rows.length >= 3 ? "lg:grid-cols-3" : rows.length === 2 ? "sm:grid-cols-2" : "";

  return (
    <div className="min-h-screen bg-app">
      <header className="glass-chrome sticky top-0 z-40 border-b border-edge">
        <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center gap-4 px-6 sm:px-8">
          <Link href="/" className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
            <BrandMark title="Yaseir" subtitle="Print Manager" size="sm" showWordmark />
          </Link>
          <nav className="ms-auto flex items-center gap-2" aria-label={t("pricing.navAria")}>
            <LanguageSwitcher />
            <Link
              href="/"
              className="hidden h-9 items-center rounded-sm px-3 text-sm font-[550] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink sm:inline-flex"
            >
              {t("pricing.product")}
            </Link>
            <ThemeToggle />
            {claims ? (
              <Button variant="primary" size="md" href="/dashboard" icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}>
                {t("pricing.openConsole")}
              </Button>
            ) : (
              <>
                <Link
                  href="/login"
                  className="hidden h-9 items-center rounded-sm px-3.5 text-sm font-[550] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink sm:inline-flex"
                >
                  {t("pricing.signIn")}
                </Link>
                <Button variant="primary" size="md" href="/signup">
                  {t("pricing.startTrial")}
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1200px] px-6 py-12 sm:px-8 lg:py-16">
        <header className="max-w-[640px]">
          <p className="text-eyebrow">{t("pricing.eyebrow")}</p>
          <h1 className="mt-2.5 text-4xl font-[670] leading-[1.1] tracking-[-0.035em] text-ink sm:text-5xl">
            {t("pricing.heading")}
          </h1>
          <p className="mt-3.5 max-w-[600px] text-base leading-[1.65] text-ink-2">
            {t("pricing.intro")}
          </p>
        </header>

        {catalogUnavailable ? (
          <Callout tone="warn" title={t("pricing.catalogUnavailableTitle")} className="mt-10 max-w-[600px]">
            <p className="leading-relaxed">
              {t("pricing.catalogUnavailableBody")}
            </p>
            <Button variant="secondary" size="sm" href="/pricing" className="mt-3" icon={<DatabaseZap className="h-4 w-4" aria-hidden />}>
              {t("pricing.retry")}
            </Button>
          </Callout>
        ) : rows.length === 0 ? (
          <Card className="mt-10 max-w-[520px]">
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-sg border border-edge bg-surface-2 text-ink-3">
                <CreditCard className="h-5 w-5" aria-hidden />
              </span>
              <h2 className="mt-4 text-md font-[620] text-ink">{t("pricing.noPlansTitle")}</h2>
              <p className="mt-2 max-w-[44ch] text-sm leading-relaxed text-ink-3">
                {t("pricing.noPlansBody")}
              </p>
              <Button variant="secondary" size="sm" href="/" className="mt-5">
                {t("pricing.backToProduct")}
              </Button>
            </div>
          </Card>
        ) : (
          <div className={`mt-10 grid gap-4 ${columns}`}>
            {rows.map((plan) => {
              const isCurrent = plan.id === currentPlanId;
              const entries = Object.entries(plan.entitlements ?? {}).filter(([, value]) => value !== false);

              return (
                <article
                  key={plan.id}
                  className={`card flex flex-col ${isCurrent ? "border-brand shadow-card" : ""}`}
                >
                  <div className="border-b border-edge-subtle px-5 py-5">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-lg font-[640] tracking-[-0.015em] text-ink">{plan.name}</h2>
                      {isCurrent && <StatusBadge tone="ok" label={t("pricing.currentPlan")} size="sm" />}
                    </div>
                    {plan.description ? (
                      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{plan.description}</p>
                    ) : (
                      <p className="mt-1.5 text-sm leading-relaxed text-ink-3">
                        {t("pricing.capacityByEntitlements")}
                      </p>
                    )}
                    <p className="mt-3 flex items-center gap-2 text-xs text-ink-3">
                      <Receipt className="h-3.5 w-3.5 text-ink-4" aria-hidden />
                      {t("pricing.billedPer", {
                        interval: billingIntervalLabel(plan.interval, t),
                        currency: (plan.currency ?? "USD").toUpperCase(),
                      })}
                    </p>
                  </div>

                  <div className="flex-1 px-5 py-5">
                    <h3 className="label-caps">{t("pricing.includedCapacity")}</h3>
                    {entries.length > 0 ? (
                      <dl className="mt-3 divide-y divide-edge-subtle border-y border-edge-subtle">
                        {entries.map(([key, value]) => (
                          <div key={key} className="flex items-baseline justify-between gap-4 py-2.5">
                            <dt className="flex min-w-0 items-start gap-2 text-sm text-ink-2">
                              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
                              <span>{entitlementLabel(key, t)}</span>
                            </dt>
                            <dd className="shrink-0 text-sm font-[620] tabular text-ink">
                              {entitlementValue(value, t, formatNumber)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="mt-3 text-sm text-ink-3">
                        {t("pricing.entitlementsManaged")}
                      </p>
                    )}
                    <p className="mt-3 text-xs leading-relaxed text-ink-3">
                      {t("pricing.creditNote")}
                    </p>
                  </div>

                  <div className="border-t border-edge-subtle px-5 py-4">
                    {isCurrent ? (
                      <div className="flex h-10 w-full items-center justify-center rounded-sm border border-edge bg-surface-2 text-sm font-[600] text-ink-2">
                        {t("pricing.yourCurrentPlan")}
                      </div>
                    ) : (
                      <Button
                        variant="primary"
                        href={destination(plan.id)}
                        className="w-full"
                        icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
                      >
                        {claims ? t("pricing.chooseThisPlan") : t("pricing.getStarted")}
                      </Button>
                    )}
                    <p className="mt-2 text-xs leading-relaxed text-ink-3">
                      {isCurrent
                        ? t("pricing.footerCurrent")
                        : claims
                          ? t("pricing.footerSignedIn")
                          : t("pricing.footerAnonymous")}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <section aria-label={t("pricing.howPlansWorkAria")} className="mt-10 max-w-[760px]">
          <h2 className="text-md font-[620] text-ink">{t("pricing.howPlansWork")}</h2>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-2">
            <li className="flex gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
              {t("pricing.point1")}
            </li>
            <li className="flex gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
              {t("pricing.point2")}
            </li>
            <li className="flex gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
              {t("pricing.point3")}
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
