import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Circle,
  CreditCard,
  KeyRound,
} from "lucide-react";
import { db } from "../../db";
import { apiKeys, odooInstallations, plans, tenantSubscriptions, tenantUsers, tenants } from "../../db/schema";
import { sessionCookieName } from "../../lib/session-config";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import { requireActiveTenantInTransaction, TenantDeletedError, TenantSuspendedError } from "../../lib/tenant-guard";
import { ManagerMutationAuthorityChangedError, requireManagerActorInTransaction } from "../../lib/manager-mutation-authorization";
import { customerSubscriptionState } from "../../lib/manual-subscriptions";
import { databaseNowMs } from "../../lib/database-clock";
import { formatManualCalendarDate } from "../../lib/manual-calendar-date";
import { roleLabel } from "../../lib/roles";
import { Button, PageContainer, PageHeader, StatusBadge, type Tone } from "../../components/ui";
import {
  DirectPrintHeroSvg,
  DirectTopologySvg,
  VisualArchitectureCard,
} from "../../components/DashboardVisuals";
import { getServerLocale, makeT } from "../../i18n/server";

export const dynamic = "force-dynamic";

function parsePlanLimit(value: unknown, fallback: number): number | "unlimited" {
  if (value === "unlimited") return "unlimited";
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.floor(value);
  return fallback;
}

export default async function DashboardPage() {
  const locale = await getServerLocale();
  const t = makeT(locale);
  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get(sessionCookieName("customer"))?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );
  if (!claims) redirect("/login");

  const snapshot = await (async () => {
    try {
      const data = await db.transaction(async (tx) => {
        await requireActiveTenantInTransaction(tx, claims.tenantId);
        await requireManagerActorInTransaction(tx, claims, "tenant.read");

        const canBilling = hasManagerPermission(claims, "billing.read");
        const canTeam = hasManagerPermission(claims, "users.read");
        const [tenant, subscription, activeKeysRes, boundDbsRes, membersRes] = await Promise.all([
          tx.query.tenants.findFirst({
            where: eq(tenants.id, claims.tenantId),
            columns: { name: true, lifecycle: true },
          }),
          tx.query.tenantSubscriptions.findFirst({
            where: eq(tenantSubscriptions.tenantId, claims.tenantId),
            columns: {
              planId: true,
              status: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
              entitlementBlocked: true,
            },
          }),
          tx
            .select({ total: count() })
            .from(apiKeys)
            .where(and(eq(apiKeys.tenantId, claims.tenantId), isNull(apiKeys.revokedAt), eq(apiKeys.odooEnabled, true))),
          tx
            .select({ total: count() })
            .from(odooInstallations)
            .where(
              and(
                eq(odooInstallations.tenantId, claims.tenantId),
                eq(odooInstallations.enabled, true),
                sql`left(${odooInstallations.id}, 3) = 'db_'`,
              ),
            ),
          tx
            .select({ total: count() })
            .from(tenantUsers)
            .where(eq(tenantUsers.tenantId, claims.tenantId)),
        ]);

        const plan =
          canBilling && subscription
            ? await tx.query.plans.findFirst({
                where: eq(plans.id, subscription.planId),
                columns: { name: true, entitlements: true },
              })
            : null;

        return {
          tenant,
          subscription,
          canBilling,
          canTeam,
          plan,
          activeApiKeys: Number(activeKeysRes[0]?.total ?? 0),
          boundOdooDbs: Number(boundDbsRes[0]?.total ?? 0),
          teamCount: Number(membersRes[0]?.total ?? 0),
        };
      });

      const subscriptionStatus = customerSubscriptionState(
        data.subscription,
        data.tenant?.lifecycle,
        await databaseNowMs(),
      );
      return { ...data, subscriptionStatus };
    } catch (error) {
      if (
        error instanceof TenantSuspendedError ||
        error instanceof TenantDeletedError ||
        error instanceof ManagerMutationAuthorityChangedError
      ) {
        return null;
      }
      throw error;
    }
  })();

  if (!snapshot) redirect("/login");

  const {
    tenant,
    subscription,
    canBilling,
    plan,
    activeApiKeys,
    boundOdooDbs,
    subscriptionStatus,
  } = snapshot;
  const isActive = subscriptionStatus === "active";
  const statusTone: Tone = isActive ? "ok" : subscriptionStatus === "suspended" ? "bad" : "warn";
  const statusKey = {
    active: "v4.onboarding.active",
    awaiting_activation: "v4.onboarding.pending",
    expired: "v4.onboarding.expired",
    suspended: "v4.onboarding.suspended",
  } as const;

  const entitlements = (plan?.entitlements ?? {}) as Record<string, unknown>;
  const maxAgents = parsePlanLimit(entitlements.max_agents, 5);
  const maxPrinters = parsePlanLimit(entitlements.max_printers, 15);
  const maxOdooDbs = parsePlanLimit(entitlements.max_odoo_dbs, 1);

  const primaryAction = !isActive && canBilling
    ? { href: "/billing", label: t("dashboard.cta.activateSubscription"), icon: <CreditCard className="h-4 w-4" /> }
    : activeApiKeys === 0
      ? { href: "/api-keys", label: t("dashboard.cta.createOdooKey"), icon: <KeyRound className="h-4 w-4" /> }
      : { href: "/api-keys", label: t("dashboard.cta.manageOdoo"), icon: <ArrowRight className="h-4 w-4 rtl:-scale-x-100" /> };

  const checklist = [
    { key: "workspace", done: true, label: t("dashboard.checklist.workspace"), href: null as string | null },
    { key: "subscription", done: isActive, label: t("dashboard.checklist.subscription"), href: !isActive && canBilling ? "/billing" : null },
    { key: "apikey", done: activeApiKeys > 0, label: t("dashboard.checklist.apiKey"), href: activeApiKeys === 0 ? "/api-keys" : null },
    { key: "odoodb", done: boundOdooDbs > 0, label: t("dashboard.checklist.odooBound"), href: boundOdooDbs === 0 ? "/api-keys" : null },
  ];
  const completedSteps = checklist.filter((item) => item.done).length;

  return (
    <PageContainer>
      <PageHeader
        title={t("v4.experience.home")}
        description={t("gateway.controlPlane.subtitle")}
        icon={<Activity className="h-4 w-4" />}
      />

      <div className="space-y-6">
        {/* Primary Licensing Status Card */}
        <section className="glass-card overflow-hidden">
          <div className="grid items-center gap-6 p-6 sm:p-8 lg:grid-cols-[1.5fr_0.5fr]">
            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center gap-2.5">
                <StatusBadge tone={statusTone} label={t(statusKey[subscriptionStatus])} />
                <span className="text-xs text-ink-3">
                  {t("home.authSignedInAs")}{" "}
                  <strong className="font-semibold text-ink">{roleLabel(claims.role, t)}</strong>
                </span>
              </div>

              <div>
                <h2 className="text-2xl font-[500] tracking-tight text-ink sm:text-[1.75rem]">
                  {tenant?.name ?? t("home.authWorkspace")}
                </h2>
                <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-ink-2">
                  {isActive ? t("dashboard.hero.activeBody") : t("dashboard.hero.pendingBody")}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button variant="primary" href={primaryAction.href} icon={primaryAction.icon}>
                  {primaryAction.label}
                </Button>
                {canBilling && isActive && subscription?.currentPeriodEnd && (
                  <span className="rounded-full border border-edge-subtle bg-surface-2/80 px-3.5 py-2 text-xs text-ink-3 tabular-nums">
                    {t("v4.subscription.end")}:{" "}
                    <strong className="font-semibold text-ink">
                      {formatManualCalendarDate(subscription.currentPeriodEnd, locale) ?? t("common.notAvailable")}
                    </strong>
                  </span>
                )}
              </div>
            </div>

            <div className="hidden items-center justify-center lg:flex">
              <div className="w-full max-w-[190px] opacity-90">
                <DirectPrintHeroSvg active={isActive} />
              </div>
            </div>
          </div>

          {/* Unified Licensing & Odoo Connection Strip */}
          <dl className="grid gap-3 border-t border-edge-subtle bg-surface/30 p-4 sm:grid-cols-3 sm:p-6">
            <div className="rounded-xl border border-edge-subtle bg-surface/60 px-5 py-4">
              <dt className="label-caps">{t("home.subscriptionLabel")}</dt>
              <dd className="mt-1 text-base font-semibold text-ink">
                {canBilling
                  ? (isActive && plan?.name ? plan.name : t("billing.noPlanSelected"))
                  : t(statusKey[subscriptionStatus])}
              </dd>
              <p className="mt-0.5 text-xs text-ink-3">
                {isActive ? t("dashboard.metric.licenseActive") : t("dashboard.metric.licenseInactive")}
              </p>
            </div>

            <div className="rounded-xl border border-edge-subtle bg-surface/60 px-5 py-4">
              <dt className="label-caps">{t("dashboard.metric.entitlementsTitle")}</dt>
              <dd className="mt-1 text-base font-semibold tabular-nums text-ink">
                {canBilling && isActive
                  ? t("dashboard.metric.entitlementsValue", {
                      agents: maxAgents === "unlimited" ? t("common.unlimited") : String(maxAgents),
                      printers: maxPrinters === "unlimited" ? t("common.unlimited") : String(maxPrinters),
                    })
                  : "—"}
              </dd>
              <p className="mt-0.5 text-xs tabular-nums text-ink-3">
                {canBilling && isActive
                  ? t("dashboard.metric.odooDbQuota", {
                      used: String(boundOdooDbs),
                      max: maxOdooDbs === "unlimited" ? t("common.unlimited") : String(maxOdooDbs),
                    })
                  : t("dashboard.metric.entitlementsHint")}
              </p>
            </div>

            <div className="rounded-xl border border-edge-subtle bg-surface/60 px-5 py-4">
              <dt className="label-caps">{t("dashboard.metric.odooKeysTitle")}</dt>
              <dd className="mt-1 text-base font-semibold tabular-nums text-ink">
                {t("dashboard.metric.odooKeysValue", {
                  keys: String(activeApiKeys),
                  dbs: String(boundOdooDbs),
                })}
              </dd>
              <p className="mt-0.5 text-xs text-ink-3">{t("dashboard.metric.odooKeysHint")}</p>
            </div>
          </dl>
        </section>

        {/* Readiness Checklist */}
        <section className="glass-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge-subtle pb-4">
            <h2 className="text-base font-[500] text-ink">{t("dashboard.checklist.title")}</h2>
            <StatusBadge
              tone={completedSteps === checklist.length ? "ok" : "warn"}
              label={t("dashboard.checklist.progress", {
                done: String(completedSteps),
                total: String(checklist.length),
              })}
            />
          </div>
          <ul className="mt-4 grid gap-2">
            {checklist.map((step) => (
              <li
                key={step.key}
                className="flex items-center justify-between gap-3 rounded-xl border border-edge-subtle bg-surface/50 px-4 py-2.5 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  {step.done ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" aria-hidden />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                  )}
                  <span className={step.done ? "text-ink-2" : "font-medium text-ink"}>{step.label}</span>
                </span>
                {step.href && (
                  <Link
                    href={step.href}
                    className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand hover:underline"
                  >
                    {t("dashboard.checklist.action")}
                    <ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* One clear explanation instead of repeating the same promise three times */}
        <section aria-label={t("dashboard.architecture.heading")} className="grid gap-4">
          <VisualArchitectureCard
            illustration={<DirectTopologySvg />}
            badge={t("dashboard.architecture.directBadge")}
            title={t("dashboard.architecture.directTitle")}
            description={t("dashboard.architecture.directBody")}
          />
        </section>
      </div>
    </PageContainer>
  );
}
