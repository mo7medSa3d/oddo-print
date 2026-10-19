import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../db";
import { plans, tenantSubscriptions, tenants } from "../db/schema";
import { eq } from "drizzle-orm";
import { ThemeToggle } from "../components/ThemeToggle";
import { LandingMotion } from "../components/marketing/LandingMotion";
import { MobileNavigation } from "../components/marketing/MobileNavigation";
import { SpotlightSurface } from "../components/marketing/SpotlightSurface";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  MonitorSmartphone,
  Printer,
  Server,
  ShieldCheck,
  Users,
  Workflow,
} from "lucide-react";
import { BrandMark } from "../components/brand";
import {
  getManagerCookieName,
  verifyWorkspaceTokenFromCookieValues,
} from "../lib/manager-auth";
import { hasManagerPermission } from "../lib/authorization";
import { isBillingAccessStatus, isSubscriptionPeriodLive } from "../lib/entitlements";
import { refreshClockSkew } from "../lib/database-clock";
import { Button, StatusBadge, type Tone } from "../components/ui";
import { getServerLocale, makeT } from "../i18n/server";
import type { MessageKey } from "../i18n/messages/en";
import { formatDate } from "../i18n/format";
import type { Locale } from "../i18n/config";
import type { Translator } from "../i18n/translate";

export const dynamic = "force-dynamic";


export default async function Home() {
  const locale = await getServerLocale();
  const t = makeT(locale);
  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get("cust_session")?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );

  if (claims) {
    const [tenant, subscription] = await Promise.all([
      db.query.tenants.findFirst({
        where: eq(tenants.id, claims.tenantId),
        columns: { name: true },
      }),
      db.query.tenantSubscriptions.findFirst({
        where: eq(tenantSubscriptions.tenantId, claims.tenantId),
        columns: { planId: true, status: true, currentPeriodEnd: true, entitlementBlocked: true },
      }),
    ]);

    const plan = subscription
      ? await db.query.plans.findFirst({
          where: eq(plans.id, subscription.planId),
          columns: { name: true },
        })
      : null;

    await refreshClockSkew();
    const hasActiveSubscription = !!subscription && !subscription.entitlementBlocked
      && isBillingAccessStatus(subscription.status)
      && (subscription.status === "past_due" || isSubscriptionPeriodLive(subscription.currentPeriodEnd));
    const trialExpired = !!subscription && subscription.status === "trialing"
      && subscription.currentPeriodEnd != null && !isSubscriptionPeriodLive(subscription.currentPeriodEnd);
    const requiresBillingAttention = !!subscription && (subscription.entitlementBlocked
      || (isBillingAccessStatus(subscription.status) && !hasActiveSubscription));

    return (
      <AuthenticatedHome
        t={t}
        locale={locale}
        tenantName={tenant?.name ?? t("home.authWorkspace")}
        role={claims.role}
        planName={plan?.name ?? null}
        subscriptionStatus={subscription?.status ?? null}
        periodEnd={subscription?.currentPeriodEnd ?? null}
        hasActiveSubscription={hasActiveSubscription}
        trialExpired={trialExpired}
        requiresBillingAttention={requiresBillingAttention}
        canBilling={hasManagerPermission(claims, "billing.read")}
        canTeam={hasManagerPermission(claims, "users.read")}
      />
    );
  }

  return <PublicHome t={t} locale={locale} />;
}

/* ============================================================
   Public marketing home
   ============================================================ */

function PublicHome({ t, locale }: { t: Translator; locale: Locale }) {
  return (
    <div data-yw-marketing className="yw-marketing overflow-x-clip">
      <LandingMotion />
      <PublicHeader t={t} />

      <main>
        {/* Hero */}
        <section className="yw-hero ambient-surface relative isolate overflow-hidden border-b border-edge-subtle bg-app">
          <div className="yw-hero-inner mx-auto grid w-full max-w-[1280px] gap-10 px-5 pb-20 pt-14 sm:px-8 sm:pb-24 sm:pt-20 lg:grid-cols-[1.03fr_0.97fr] lg:items-center lg:gap-16 lg:px-10 lg:pb-32 lg:pt-24">
            <div className="relative z-10 max-w-[650px]">
              <p data-yw-intro className="yw-hero-eyebrow text-eyebrow">{t("home.heroEyebrow")}</p>

              <h1 data-yw-intro className="yw-hero-title mt-5 max-w-[760px] text-[clamp(2.75rem,5vw,5.25rem)] font-[720] leading-[1.055] tracking-[-0.055em] text-ink">
                {t("home.heroTitle1")}
                <br className="hidden sm:block" /> {t("home.heroTitle2")}
              </h1>

              <p data-yw-intro className="mt-7 max-w-[570px] text-lg leading-[1.7] text-ink-2">
                {t("home.heroBody")}
              </p>

              <div data-yw-intro className="yw-hero-actions mt-9 flex flex-col gap-3 sm:flex-row">
                <Button
                  variant="primary"
                  size="lg"
                  href="/signup"
                  icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
                >
                  {t("home.heroCta")}
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  href="#how-it-works"
                  icon={<ArrowUpRight className="h-4 w-4" />}
                >
                  {t("home.heroSecondary")}
                </Button>
              </div>

              <ul data-yw-intro className="yw-hero-checks mt-10 grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
                {[
                  t("home.heroCheck1"),
                  t("home.heroCheck2"),
                  t("home.heroCheck3"),
                  t("home.heroCheck4"),
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-base text-ink-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <GatewayHeroVisual t={t} />
          </div>
        </section>

        {/* Product */}
        <section id="product" className="yw-product-section scroll-mt-20 border-b border-edge-subtle bg-surface">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 sm:px-8 sm:py-20 lg:px-8">
            <SectionIntro
              eyebrow={t("home.productEyebrow")}
              title={t("home.productTitle")}
              text={t("home.productText")}
            />

            <div className="mt-12 grid gap-5 lg:grid-cols-3">
              <ProductCard
                icon={<Workflow className="h-4 w-4" />}
                title={t("home.capability1Title")}
                text={t("home.capability1Text")}
                items={[t("home.capability1Item1"), t("home.capability1Item2"), t("home.capability1Item3")]}
              />
              <ProductCard
                icon={<Printer className="h-4 w-4" />}
                title={t("home.capability2Title")}
                text={t("home.capability2Text")}
                items={[t("home.capability2Item1"), t("home.capability2Item2"), t("home.capability2Item3")]}
              />
              <ProductCard
                icon={<MonitorSmartphone className="h-4 w-4" />}
                title={t("home.capability3Title")}
                text={t("home.capability3Text")}
                items={[t("home.capability3Item1"), t("home.capability3Item2"), t("home.capability3Item3")]}
              />
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="yw-flow-section scroll-mt-20 border-b border-edge-subtle bg-app">
          <div className="mx-auto grid w-full max-w-[1200px] gap-10 px-6 py-16 sm:px-8 sm:py-20 lg:grid-cols-[0.9fr_1.1fr] lg:gap-14 lg:px-8">
            <div>
              <SectionIntro
                eyebrow={t("home.flowEyebrow")}
                title={t("home.flowTitle")}
                text={t("home.flowText")}
              />
              <p className="mt-6 inline-flex items-center gap-2 rounded-sm border border-edge bg-surface-2 px-3 py-1.5 text-xs font-[600] text-ink-3">
                {t("home.flowChain")}
              </p>
            </div>

            <ol className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge bg-surface shadow-card">
              <FlowRow
                icon={<Workflow className="h-4 w-4" />}
                number="01"
                title="Odoo"
                text={t("home.flow1Text")}
              />
              <FlowRow
                icon={<Server className="h-4 w-4" />}
                number="02"
                title="Gateway"
                text={t("home.flow2Text")}
              />
              <FlowRow
                icon={<MonitorSmartphone className="h-4 w-4" />}
                number="03"
                title={t("home.flow3Title")}
                text={t("home.flow3Text")}
              />
              <FlowRow
                icon={<Printer className="h-4 w-4" />}
                number="04"
                title={t("home.flow4Title")}
                text={t("home.flow4Text")}
              />
            </ol>
          </div>
        </section>

        {/* Reliability */}
        <section id="reliability" className="yw-reliability-section scroll-mt-20 border-b border-edge-subtle bg-surface">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 sm:px-8 sm:py-20 lg:px-8">
            <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
              <SectionIntro
                eyebrow={t("home.reliabilityEyebrow")}
                title={t("home.reliabilityTitle")}
                text={t("home.reliabilityText")}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <ReliabilityCell
                  title={t("home.reliability1Title")}
                  text={t("home.reliability1Text")}
                />
                <ReliabilityCell
                  title={t("home.reliability2Title")}
                  text={t("home.reliability2Text")}
                />
                <ReliabilityCell
                  title={t("home.reliability3Title")}
                  text={t("home.reliability3Text")}
                />
                <ReliabilityCell
                  title={t("home.reliability4Title")}
                  text={t("home.reliability4Text")}
                />
              </div>
            </div>
          </div>
        </section>

        {/* Security */}
        <section id="security" className="yw-security-section scroll-mt-20 border-b border-edge-subtle bg-app">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 sm:px-8 sm:py-20 lg:px-8">
            <SectionIntro
              eyebrow={t("home.securityEyebrow")}
              title={t("home.securityTitle")}
              text={t("home.securityText")}
            />

            <div className="mt-10 grid gap-4 lg:grid-cols-2">
              <SecurityPanel
                icon={<KeyRound className="h-4 w-4" />}
                title={t("home.security1Title")}
                items={[
                  t("home.security1Item1"),
                  t("home.security1Item2"),
                  t("home.security1Item3"),
                ]}
              />
              <SecurityPanel
                icon={<ShieldCheck className="h-4 w-4" />}
                title={t("home.security2Title")}
                items={[
                  t("home.security2Item1"),
                  t("home.security2Item2"),
                  t("home.security2Item3"),
                ]}
              />
            </div>

            <p className="mt-6 text-sm text-ink-3">
              {t("home.securityNote")}
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="bg-surface">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 sm:px-8 sm:py-20 lg:px-8">
            <div data-yw-reveal className="yw-final-cta brand-hairline relative overflow-hidden rounded-2xl border border-edge bg-surface-2 px-7 py-12 sm:px-12 sm:py-14">
              <div className="relative grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
                <div className="max-w-[640px]">
                  <p className="text-eyebrow">{t("home.ctaEyebrow")}</p>
                  <h2 className="mt-3 text-3xl font-[660] leading-[1.14] tracking-[-0.03em] text-ink sm:text-4xl">
                    {t("home.ctaTitle")}
                  </h2>
                  <p className="mt-3 max-w-[600px] text-base leading-relaxed text-ink-2">
                    {t("home.ctaText")}
                  </p>
                </div>

                <div className="flex flex-col gap-2.5 sm:flex-row lg:flex-col lg:items-stretch">
                  <Button variant="primary" size="lg" href="/signup" icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}>
                    {t("home.ctaPrimary")}
                  </Button>
                  <Button variant="secondary" size="lg" href="/pricing" icon={<ChevronRight className="h-4 w-4 rtl:-scale-x-100" />}>
                    {t("home.ctaSecondary")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicFooter t={t} />
    </div>
  );
}

function PublicHeader({ t }: { t: Translator }) {
  return (
    <header className="yw-public-header glass-chrome sticky top-0 z-40 border-b border-edge">
      <div className="mx-auto flex h-[72px] w-full max-w-[1280px] items-center gap-4 px-5 sm:px-8 lg:px-10">
        <Link href="/" className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
          <BrandMark title="Yaseir" subtitle="Print Manager" size="sm" showWordmark />
        </Link>

        <nav className="hidden min-w-0 flex-1 items-center gap-1 md:flex" aria-label={t("home.brandAria")}>
          <Anchor href="#product">{t("home.productEyebrow")}</Anchor>
          <Anchor href="#how-it-works">{t("home.navHowItWorks")}</Anchor>
          <Anchor href="#reliability">{t("home.navReliability")}</Anchor>
          <Anchor href="#security">{t("home.navSecurity")}</Anchor>
          <Link
            href="/pricing"
            className="inline-flex h-9 items-center rounded-sm px-3 text-sm font-[550] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-2"
          >
            {t("home.navPricing")}
          </Link>
        </nav>

        <div className="ms-auto flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />

          <div className="hidden items-center gap-2 sm:flex">
            <Link
              href="/login"
              className="inline-flex h-9 items-center rounded-sm px-3.5 text-sm font-[550] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
            >
              {t("auth.signIn.submit")}
            </Link>
            <Button variant="primary" size="md" href="/signup">
              {t("home.startTrial")}
            </Button>
          </div>

          <MobileNavigation
            menuLabel={t("home.navMenu")}
            closeLabel={t("ui.closeDialog")}
            title={t("home.brandAria")}
            actionLabel={t("home.startTrial")}
            items={[
              { href: "#product", label: t("home.productEyebrow") },
              { href: "#how-it-works", label: t("home.navHowItWorks") },
              { href: "#reliability", label: t("home.navReliability") },
              { href: "#security", label: t("home.navSecurity") },
              { href: "/pricing", label: t("home.navPricing") },
              { href: "/login", label: t("auth.signIn.submit") },
            ]}
          />
        </div>
      </div>
    </header>
  );
}

function PublicFooter({ t }: { t: Translator }) {
  return (
    <footer className="border-t border-edge-subtle bg-surface">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-10 sm:px-8 lg:flex-row lg:items-start lg:justify-between lg:px-8">
        <div>
          <BrandMark title="Yaseir" subtitle="Print Manager" size="sm" showWordmark />
          <p className="mt-3 max-w-[440px] text-sm leading-relaxed text-ink-3">
            {t("home.footerBlurb")}
          </p>
        </div>
        <nav aria-label={t("home.footerAria")} className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-[550] text-ink-2">
          <Link href="/pricing" className="rounded-xs transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-2">{t("home.navPricing")}</Link>
          <Link href="/login" className="rounded-xs transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-2">{t("auth.signIn.submit")}</Link>
          <Link href="/signup" className="rounded-xs transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-2">{t("auth.signup.submit")}</Link>
          <span className="text-ink-3">Odoo 19</span>
        </nav>
      </div>
    </footer>
  );
}

function Anchor({ href, children, block = false }: { href: string; children: ReactNode; block?: boolean }) {
  return (
    <a
      href={href}
      className={
        block
          ? "menu-item"
          : "inline-flex h-9 items-center rounded-sm px-3 text-sm font-[550] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-2"
      }
    >
      {children}
    </a>
  );
}

/** Static product illustration — structure of the real pipeline, not fake telemetry. */
function GatewayHeroVisual({ t }: { t: Translator }) {
  return (
    <div data-yw-intro className="yw-hero-stage ambient-surface relative isolate overflow-hidden rounded-[26px] border border-edge bg-surface shadow-card">
      <div className="yw-hero-stage-header flex items-center justify-between gap-3 border-b border-edge-subtle bg-surface-2/70 px-5 py-4">
        <BrandMark title={t("home.visualTitle")} subtitle={t("home.visualSubtitle")} size="sm" />
        <StatusBadge tone="ok" label={t("home.visualBadge")} size="sm" />
      </div>

      <div className="relative px-5 py-6 sm:px-7 sm:py-7">
        <div className="label-caps">{t("home.visualPath")}</div>
        <ol className="yw-hero-pipeline mt-5 space-y-2">
          <RuntimeRow index="01" icon={<Workflow className="h-3.5 w-3.5" />} title={t("home.visualStep1Title")} meta={t("home.visualStep1Text")} />
          <RuntimeRow index="02" icon={<Server className="h-3.5 w-3.5" />} title={t("home.visualStep2Title")} meta={t("home.visualStep2Text")} />
          <RuntimeRow index="03" icon={<MonitorSmartphone className="h-3.5 w-3.5" />} title={t("home.visualStep3Title")} meta={t("home.visualStep3Text")} />
          <RuntimeRow index="04" icon={<Printer className="h-3.5 w-3.5" />} title={t("home.visualStep4Title")} meta={t("home.visualStep4Text")} />
        </ol>

        <div className="mt-4">
          <div className="label-caps">{t("home.visualGuarantees")}</div>
          <ul className="mt-2 space-y-2">
            <HeroCheck text={t("home.heroCheck1")} />
            <HeroCheck text={t("home.visualGuarantee2")} />
            <HeroCheck text={t("home.visualGuarantee3")} />
          </ul>
        </div>
      </div>

      <div className="border-t border-edge-subtle bg-surface-2/70 px-5 py-3.5 text-xs text-ink-3">
        {t("home.visualFooter")}
      </div>
    </div>
  );
}

function HeroCheck({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2 text-base text-ink-2">
      <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
      <span>{text}</span>
    </li>
  );
}

function RuntimeRow({ index, icon, title, meta }: { index: string; icon: ReactNode; title: string; meta: string }) {
  return (
    <li data-yw-flow-item className="yw-hero-step flex items-center gap-3 rounded-xl border border-edge-subtle bg-surface px-4 py-3.5">
      <span className="yw-hero-step-number flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle font-mono text-xs font-semibold tabular text-brand">{index}</span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-[600] text-ink">
          <span className="text-ink-4" aria-hidden>{icon}</span>
          {title}
        </span>
        <span className="mt-0.5 block text-xs text-ink-3">{meta}</span>
      </span>
    </li>
  );
}

function SectionIntro({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return (
    <div data-yw-reveal className="max-w-[680px]">
      <p className="text-eyebrow">{eyebrow}</p>
      <h2 className="mt-2.5 text-3xl font-[660] leading-[1.14] tracking-[-0.03em] text-ink sm:text-4xl">{title}</h2>
      <p className="mt-3 max-w-[600px] text-base leading-[1.65] text-ink-2">{text}</p>
    </div>
  );
}

function ProductCard({ icon, title, text, items }: { icon: ReactNode; title: string; text: string; items: string[] }) {
  return (
    <SpotlightSurface className="card-interactive flex h-full flex-col rounded-2xl border border-edge bg-surface p-6 shadow-card sm:p-7">
      <span className="flex h-8 w-8 items-center justify-center rounded-md border border-edge bg-surface-2 text-ink-3">
        {icon}
      </span>
      <h3 className="mt-3.5 text-md font-[620] tracking-[-0.014em] text-ink">{title}</h3>
      <p className="mt-2 text-base leading-relaxed text-ink-2">{text}</p>
      <ul className="mt-4 space-y-2 border-t border-edge-subtle pt-4">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-base text-ink-2">
            <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </SpotlightSurface>
  );
}

function FlowRow({ icon, number, title, text }: { icon: ReactNode; number: string; title: string; text: string }) {
  return (
    <li data-yw-reveal className="yw-flow-row flex gap-4 px-5 py-5 sm:px-7 sm:py-6">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-surface-2 text-ink-3">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h3 className="text-md font-[600] text-ink">{title}</h3>
          <span className="font-mono text-xs tabular text-ink-4">{number}</span>
        </div>
        <p className="mt-1 text-base leading-relaxed text-ink-2">{text}</p>
      </div>
    </li>
  );
}

function ReliabilityCell({ title, text }: { title: string; text: string }) {
  return (
    <SpotlightSurface className="card-interactive rounded-2xl border border-edge bg-surface p-6 shadow-card">
      <h3 className="flex items-center gap-2 text-md font-[600] text-ink">
        <ShieldCheck className="h-4 w-4 text-ok" aria-hidden />
        {title}
      </h3>
      <p className="mt-1.5 text-base leading-relaxed text-ink-2">{text}</p>
    </SpotlightSurface>
  );
}

function SecurityPanel({ icon, title, items }: { icon: ReactNode; title: string; items: string[] }) {
  return (
    <article className="rounded-xl border border-edge bg-surface p-5 shadow-card sm:p-6">
      <span className="flex h-8 w-8 items-center justify-center rounded-md border border-edge bg-surface-2 text-ink-3">
        {icon}
      </span>
      <h3 className="mt-3.5 text-md font-[620] tracking-[-0.014em] text-ink">{title}</h3>
      <ul className="mt-4 space-y-2.5 border-t border-edge-subtle pt-4">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-base leading-relaxed text-ink-2">
            <Check className="mt-1 h-4 w-4 shrink-0 text-brand" aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/* ============================================================
   Signed-in landing
   ============================================================ */

function AuthenticatedHome({
  t,
  locale,
  tenantName,
  role,
  planName,
  subscriptionStatus,
  periodEnd,
  hasActiveSubscription,
  trialExpired,
  requiresBillingAttention,
  canBilling,
  canTeam,
}: {
  t: Translator;
  locale: Locale;
  tenantName: string;
  role: string;
  planName: string | null;
  subscriptionStatus: string | null;
  periodEnd: Date | null;
  hasActiveSubscription: boolean;
  trialExpired: boolean;
  requiresBillingAttention: boolean;
  canBilling: boolean;
  canTeam: boolean;
}) {
  const hasPlan = !!planName && hasActiveSubscription;
  const statusTone: Tone = requiresBillingAttention
    ? "warn"
    : !subscriptionStatus
      ? "neutral"
      : subscriptionStatus === "active"
        ? "ok"
        : subscriptionStatus === "trialing"
          ? "brand"
          : subscriptionStatus === "past_due" || subscriptionStatus === "paused"
            ? "warn"
            : "bad";

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-9 sm:px-8">
      <section className="card overflow-hidden">
        <div className="flex flex-col gap-5 px-6 py-6 sm:flex-row sm:items-start sm:justify-between sm:px-7">
          <div className="min-w-0">
            <p className="text-eyebrow">{t("home.authWorkspace")}</p>
            <h1 className="mt-2 text-3xl font-[660] tracking-[-0.03em] text-ink">{tenantName}</h1>
            <p className="mt-1.5 text-base text-ink-2">
              {t("home.authSignedInAs")} <span className="font-[600] capitalize text-ink">{role.replace(/_/g, " ")}</span>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="primary" href="/dashboard" icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}>
              {t("home.authOpenConsole")}
            </Button>
            {canBilling && (
              <Button variant="secondary" href="/billing" icon={<CreditCard className="h-4 w-4" />}>
                {t("nav.billing")}
              </Button>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-1 divide-y divide-edge-subtle border-t border-edge-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="px-6 py-4">
            <dt className="label-caps">{t("home.planLabel")}</dt>
            <dd className="mt-1.5 text-sm font-[600] text-ink">{hasPlan ? planName : planName ? `${planName} · ${trialExpired ? t("billing.trialExpired") : t("billing.ended")}` : t("billing.noPlanSelected")}</dd>
          </div>
          <div className="px-6 py-4">
            <dt className="label-caps">{t("home.subscriptionLabel")}</dt>
            <dd className="mt-1.5">
              <StatusBadge
                tone={statusTone}
                label={trialExpired ? t("billing.trialExpired") : requiresBillingAttention ? t("billing.paymentAttention")
                  : subscriptionStatus ? formatStatus(subscriptionStatus, t) : t("billing.notConfigured")}
              />
            </dd>
          </div>
          <div className="px-6 py-4">
            <dt className="label-caps">{t("home.renewalLabel")}</dt>
            <dd className="mt-1.5 text-sm font-[600] text-ink">
              {periodEnd ? formatDate(periodEnd, locale) : "—"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-4 grid gap-4 md:grid-cols-3">
        <QuickLink
          href="/dashboard"
          icon={<LayoutDashboard className="h-4 w-4" />}
          title={t("nav.console")}
          text={t("home.quickDashboard")}
          meta={hasPlan ? planName ?? "" : t("home.quickDashboardMeta")}
          t={t}
        />
        <QuickLink
          href="/api-keys"
          icon={<KeyRound className="h-4 w-4" />}
          title={t("home.quickOdooTitle")}
          text={t("home.quickOdooText")}
          meta={t("home.quickOdooMeta")}
          t={t}
        />
        {canTeam ? (
          <QuickLink
            href="/team"
            icon={<Users className="h-4 w-4" />}
            title={t("home.quickTeamTitle")}
            text={t("home.quickTeamText")}
            meta={t("home.quickTeamMeta")}
            t={t}
          />
        ) : (
          <QuickLink
            href="/settings"
            icon={<LayoutDashboard className="h-4 w-4" />}
            title={t("home.quickSettingsTitle")}
            text={t("home.quickSettingsText")}
            meta={t("home.quickSettingsMeta")}
            t={t}
          />
        )}
      </section>

      <p className="mt-8 text-center text-sm text-ink-3">{t("home.printChain")}</p>
    </div>
  );
}

function QuickLink({
  href,
  icon,
  title,
  text,
  meta,
  t,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  text: string;
  meta: string;
  t: Translator;
}) {
  return (
    <Link
      href={href}
      className="card-interactive group rounded-xl border border-edge bg-surface p-5 shadow-card"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-md font-[600] tracking-[-0.014em] text-ink">
          <span className="text-ink-4 transition-colors group-hover:text-brand" aria-hidden>{icon}</span>
          {title}
        </span>
        <span className="text-xs text-ink-3">{meta}</span>
      </div>
      <p className="mt-1.5 text-base leading-relaxed text-ink-2">{text}</p>
      <span className="mt-3 inline-flex items-center gap-1 text-sm font-[600] text-brand">
        {t("home.quickLinkOpen")} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
      </span>
    </Link>
  );
}

function formatStatus(status: string, t: Translator) {
  const known: Record<string, MessageKey> = {
    trialing: "billing.trial",
    active: "billing.active",
    past_due: "billing.paymentAttention",
    unpaid: "billing.paymentRequired",
    paused: "billing.paused",
    incomplete: "billing.paymentRequired",
    incomplete_expired: "billing.checkoutExpired",
    cancelled: "billing.canceled",
  };
  if (known[status]) return t(known[status]);
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
