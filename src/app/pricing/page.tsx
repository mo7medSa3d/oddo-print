import { cookies } from "next/headers";
import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { tenantSubscriptions, tenants, plans } from "../../db/schema";
import { customerSubscriptionState } from "../../lib/manual-subscriptions";
import { databaseNowMs } from "../../lib/database-clock";
import { resolveThreePlanCatalog, type UnifiedPlanRecord } from "../../lib/plan-price";
import { db } from "../../db";
import { sessionCookieName } from "../../lib/session-config";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { getServerLocale, makeT } from "../../i18n/server";
import { Button, Callout } from "../../components/ui";
import { BrandMark } from "../../components/brand";
import { ThemeToggle } from "../../components/ThemeToggle";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";
import { UnifiedBillingView } from "../../components/UnifiedBillingView";
import { logError } from "../../lib/log";
import { requireActiveTenantInTransaction, TenantSuspendedError, TenantDeletedError } from "../../lib/tenant-guard";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../lib/manager-mutation-authorization";

export const dynamic = "force-dynamic";

export default async function Pricing() {
  const locale = await getServerLocale();
  const t = makeT(locale);
  let rows: UnifiedPlanRecord[] = [];
  const jar = await cookies();
  let claims = await verifyWorkspaceTokenFromCookieValues(
    jar.get(sessionCookieName("customer"))?.value ?? null,
    jar.get(getManagerCookieName())?.value ?? null,
  );
  if (claims) {
    const member = claims;
    let subscribed = false;
    try {
      // The public catalog is readable without a session, but any tenant
      // subscription lookup and owner/member redirect must be fenced by the
      // same live membership and session as the authenticated homepage.
      const { sub, tenant } = await db.transaction(async tx => {
        await requireActiveTenantInTransaction(tx, member.tenantId);
        await requireManagerActorInTransaction(tx, member, "tenant.read");
        const [sub, tenant] = await Promise.all([
          tx.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, member.tenantId) }),
          tx.query.tenants.findFirst({ where: eq(tenants.id, member.tenantId), columns: { lifecycle: true } }),
        ]);
        return { sub, tenant };
      });
      subscribed = customerSubscriptionState(sub, tenant?.lifecycle, await databaseNowMs()) === "active";
    } catch (error) {
      if (
        error instanceof ManagerMutationAuthorityChangedError ||
        error instanceof TenantSuspendedError ||
        error instanceof TenantDeletedError
      ) {
        // A revoked principal or disabled workspace is a public visitor for
        // catalog purposes; never preserve stale owner navigation.
        claims = null;
      } else {
        throw error;
      }
    }
    // Next.js redirect throws. Never swallow it inside the authority catch.
    if (claims && subscribed) redirect(claims.role === "owner" ? "/billing" : "/dashboard");
  }

  let unavailable = false;
  try {
    rows = await db
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
      .orderBy(asc(plans.displayOrder), asc(plans.name));
  } catch {
    unavailable = true;
    logError("pricing.catalog_load_failed", { error: "Public catalog unavailable" });
  }

  const catalog = resolveThreePlanCatalog(rows);
  const publicRole = claims ? (claims.role === "owner" ? "owner" : "member") : "anonymous";

  return (
    <div className="min-h-screen bg-app">
      <header className="sticky top-0 z-20 border-b border-edge-subtle bg-surface/85 backdrop-blur-md">
        <div className="mx-auto grid max-w-[1160px] grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex sm:min-h-[72px] sm:gap-5 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="inline-flex min-w-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
          >
            <BrandMark title="Yaseir" size="sm" showWordmark />
          </Link>
          <div className="col-start-2 row-start-1 flex items-center gap-0 sm:ms-auto">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
          <nav className="col-span-2 flex w-full items-center gap-2 sm:w-auto" aria-label={t("pricing.navAria")}>
            {claims ? (
              <Button href="/dashboard" variant="secondary" size="md" className="w-full whitespace-nowrap sm:w-auto">
                {t("pricing.openConsole")}
              </Button>
            ) : (
              <>
                <Button href="/login" variant="secondary" size="md" className="flex-1 whitespace-nowrap sm:flex-none">
                  {t("pricing.signIn")}
                </Button>
                <Button href="/signup" variant="primary" size="md" className="flex-1 whitespace-nowrap sm:flex-none">
                  {t("pricing.getStarted")}
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1160px] px-4 pb-20 pt-10 sm:px-6 sm:pt-14 lg:px-8">
        <header className="mb-10 max-w-2xl">
          <h1 className="text-[clamp(2rem,3vw,2.625rem)] font-semibold leading-tight tracking-tight text-ink">
            {t("v4.pricing.title")}
          </h1>
          <p className="mt-2 text-base text-ink-3">{t("v4.pricing.intro")}</p>
        </header>

        {unavailable ? (
          <Callout tone="warn" title={t("pricing.catalogUnavailableTitle")}>
            {t("pricing.catalogUnavailableBody")}
            <div className="mt-3">
              <Button href="/pricing" variant="secondary">
                {t("pricing.retry")}
              </Button>
            </div>
          </Callout>
        ) : (
          <UnifiedBillingView
            mode="public"
            plans={catalog.plans}
            usingFallbackCatalog={catalog.usingFallback}
            publicRole={publicRole}
          />
        )}
      </main>
    </div>
  );
}
