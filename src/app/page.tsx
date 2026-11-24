import { sessionCookieName } from "../lib/session-config";
import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../db";
import { plans, tenantSubscriptions, tenants } from "../db/schema";
import { eq } from "drizzle-orm";
import { requireActiveTenantInTransaction, TenantSuspendedError, TenantDeletedError } from "../lib/tenant-guard";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../lib/manager-mutation-authorization";
import { ThemeToggle } from "../components/ThemeToggle";
import { MobileNavigation } from "../components/marketing/MobileNavigation";
import { LandingMotion } from "../components/marketing/LandingMotion";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import {
  ArrowRight,
  ChevronRight,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  PlayCircle,
  PlugZap,
  Settings,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
import { BrandMark } from "../components/brand";
import {
  getManagerCookieName,
  verifyWorkspaceTokenFromCookieValues,
} from "../lib/manager-auth";
import { hasManagerPermission } from "../lib/authorization";
import { customerSubscriptionState } from "../lib/manual-subscriptions";
import { databaseNowMs } from "../lib/database-clock";
import { roleLabel } from "../lib/roles";
import { Button, StatusBadge, type Tone } from "../components/ui";
import { getServerLocale, makeT } from "../i18n/server";
import { formatManualCalendarDate } from "../lib/manual-calendar-date";
import type { Locale } from "../i18n/config";
import type { Translator } from "../i18n/translate";

export const dynamic = "force-dynamic";

export default async function Home() {
  const locale = await getServerLocale();
  const t = makeT(locale);
  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get(sessionCookieName("customer"))?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );

  if (claims) {
    const view = await (async () => {
      try {
        const { tenant, subscription, canBilling, plan } = await db.transaction(async tx => {
          await requireActiveTenantInTransaction(tx, claims.tenantId);
          await requireManagerActorInTransaction(tx, claims, "tenant.read");
          const [tenant, subscription] = await Promise.all([
            tx.query.tenants.findFirst({
              where: eq(tenants.id, claims.tenantId),
              columns: { name: true, lifecycle: true },
            }),
            tx.query.tenantSubscriptions.findFirst({
              where: eq(tenantSubscriptions.tenantId, claims.tenantId),
              columns: { planId: true, status: true, currentPeriodStart: true, currentPeriodEnd: true, entitlementBlocked: true },
            }),
          ]);
          const canBilling = hasManagerPermission(claims, "billing.read");
          const plan = canBilling && subscription
            ? await tx.query.plans.findFirst({
                where: eq(plans.id, subscription.planId),
                columns: { name: true },
              })
            : null;
          return { tenant, subscription, canBilling, plan };
        });
        const subscriptionStatus = customerSubscriptionState(subscription, tenant?.lifecycle, await databaseNowMs());
        return { tenant, subscription, canBilling, plan, subscriptionStatus };
      } catch (error) {
        if (error instanceof TenantSuspendedError || error instanceof TenantDeletedError ||
            error instanceof ManagerMutationAuthorityChangedError) {
          return null;
        }
        throw error;
      }
    })();
    if (view) {
      const { tenant, subscription, canBilling, plan, subscriptionStatus } = view;
      return (
        <AuthenticatedHome
          t={t}
          locale={locale}
          tenantName={tenant?.name ?? t("home.authWorkspace")}
          role={claims.role}
          planName={plan?.name ?? null}
          subscriptionStatus={subscriptionStatus}
          periodEnd={canBilling ? subscription?.currentPeriodEnd ?? null : null}
          canBilling={canBilling}
          canTeam={hasManagerPermission(claims, "users.read")}
        />
      );
    }
  }

  return <PublicHome t={t} locale={locale} />;
}

/* ============================================================
   Public landing — Apple iOS 27 minimal Licensing-Only Gateway
   ============================================================ */

function PublicHome({ t, locale }: { t: Translator; locale: Locale }) {
  const isAr = locale === "ar";
  const pillars = [
    {
      icon: <ShieldCheck className="h-5 w-5 text-brand" aria-hidden="true" />,
      title: isAr ? "تحكم كامل بالتراخيص" : "License Control",
      lead: isAr
        ? "تراخيص Ed25519 موقّعة تُتحقق محلياً دون انقطاع حتى عند توقف الإنترنت."
        : "Signed Ed25519 entitlements verified offline across every workstation.",
    },
    {
      icon: <Zap className="h-5 w-5 text-brand" aria-hidden="true" />,
      title: isAr ? "سرعة محلية فائقة" : "Native Speed",
      lead: isAr
        ? "اتصال مباشر بين أودو والطابعات المحلية دون أي وسيط أو طابور سحابي."
        : "Direct Odoo-to-printer execution on your network with zero cloud relay.",
    },
    {
      icon: <PlugZap className="h-5 w-5 text-brand" aria-hidden="true" />,
      title: isAr ? "تكامل فوري مع أودو" : "Zero-Friction Odoo",
      lead: isAr
        ? "اربط قاعدة بيانات أودو بمفتاح ترخيص واحد وابدأ الطباعة خلال دقائق."
        : "Bind your Odoo database with one API key and start printing immediately.",
    },
  ];

  return (
    <div data-yw-marketing className="yw-marketing yw-public-site min-h-screen overflow-x-clip bg-app">
      <LandingMotion />
      <PublicHeader t={t} />

      <main id="main-content">
        {/* Hero */}
        <section className="yw-hero relative isolate overflow-hidden pt-24 pb-14 sm:pt-32 sm:pb-16">
          <div className="yw-hero-inner mx-auto flex w-full max-w-[900px] flex-col items-center px-5 text-center sm:px-8">
            <p
              data-yw-intro
              className="text-xs font-semibold uppercase tracking-[0.18em] text-brand"
            >
              {isAr ? "بوابة التراخيص لطباعة أودو" : "Licensing Gateway for Odoo"}
            </p>

            <h1
              data-yw-intro
              className="yw-hero-title mt-5 text-[clamp(2.5rem,6vw,4rem)] font-[500] leading-[1.06] tracking-tight text-ink"
            >
              {isAr ? "تراخيص طباعة أودو. ببساطة." : "Odoo printing, licensed right."}
            </h1>

            <p
              data-yw-intro
              className="mt-5 max-w-[620px] text-base leading-[1.7] text-ink-2 sm:text-lg"
            >
              {isAr
                ? "بوابة تراخيص سحابية خفيفة تُفعّل الطباعة المباشرة بين أودو والطابعات المحلية دون أي وسيط سحابي."
                : "A licensing-only gateway that unlocks direct, native-speed printing between Odoo and your local printers."}
            </p>

            <div
              data-yw-intro
              className="mt-9 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row"
            >
              <Button
                variant="primary"
                size="lg"
                href="/signup"
                icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
              >
                {t("home.ctaPrimary")}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                href="/pricing"
                icon={<ChevronRight className="h-4 w-4 rtl:-scale-x-100" />}
              >
                {t("home.ctaSecondary")}
              </Button>
            </div>
          </div>
        </section>

        {/* Dedicated video section — large, clear, easy to scan */}
        <section id="see-it" aria-labelledby="see-it-title" className="scroll-mt-20 py-16 sm:py-24">
          <div className="mx-auto w-full max-w-[1280px] px-5 sm:px-8 lg:px-10">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-eyebrow">{isAr ? "شاهدها تعمل" : "See it in action"}</p>
              <h2 id="see-it-title" className="mt-3 text-[clamp(1.75rem,4vw,2.5rem)] font-[500] leading-tight tracking-tight text-ink">
                {isAr ? "من أودو إلى الطابعة، مباشرة" : "From Odoo to paper, directly"}
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-ink-2 sm:text-base">
                {isAr
                  ? "فيديوهان قصيران يوضّحان إيصال نقطة البيع والفاتورة أثناء طباعتهما على طابعة محلية."
                  : "Two short demos showing a POS receipt and an A4 invoice printing on a local printer."}
              </p>
            </div>

            <div className="mt-10 grid gap-6 lg:grid-cols-2">
              {[
                {
                  src: "/videos/yaseir-pos-scrub-1080p.mp4",
                  poster: "/videos/yaseir-pos-poster.webp",
                  label: isAr ? "إيصالات نقاط البيع" : "POS Receipts",
                  hint: isAr ? "اطبع إيصال المبيعات فور تأكيد الطلب" : "Print a receipt the moment an order is confirmed",
                },
                {
                  src: "/videos/yaseir-a4-scrub-1080p.mp4",
                  poster: "/videos/yaseir-a4-poster.webp",
                  label: isAr ? "الفواتير ومستندات A4" : "A4 & Invoices",
                  hint: isAr ? "اطبع الفواتير والتقارير بحجم A4 الكامل" : "Print full-size invoices and reports on A4",
                },
              ].map((clip) => (
                <figure key={clip.src} data-yw-reveal className="overflow-hidden rounded-2xl border border-edge-subtle bg-surface/40 p-1.5 sm:p-2">
                  <video
                    src={clip.src}
                    poster={clip.poster}
                    aria-label={clip.label}
                    controls
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    className="aspect-video w-full rounded-xl bg-surface-2 object-cover"
                  />
                  <figcaption className="flex items-start gap-2.5 px-3 py-3 sm:px-4 sm:py-4">
                    <PlayCircle className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink sm:text-base">{clip.label}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-ink-2 sm:text-sm">{clip.hint}</span>
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        {/* 3-Pillar Summary */}
        <section id="how-it-works" className="scroll-mt-20 py-14 sm:py-20">
          <div className="mx-auto w-full max-w-[1120px] px-5 sm:px-8 lg:px-10">
            <div className="grid gap-5 md:grid-cols-3">
              {pillars.map((pillar) => (
                <PillarCard
                  key={pillar.title}
                  icon={pillar.icon}
                  title={pillar.title}
                  lead={pillar.lead}
                />
              ))}
            </div>
          </div>
        </section>

        {/* Minimal Closing CTA */}
        <section className="py-12 pb-20 sm:py-16 sm:pb-24">
          <div className="mx-auto w-full max-w-[1120px] px-5 sm:px-8 lg:px-10">
            <div
              data-yw-reveal
              className="flex flex-col items-start justify-between gap-6 border-t border-edge-subtle pt-10 lg:flex-row lg:items-center"
            >
              <div className="max-w-[560px]">
                <h2 className="text-2xl font-[500] leading-[1.18] text-ink">
                  {t("home.ctaTitle")}
                </h2>
                <p className="mt-2 text-sm text-ink-2">
                  {isAr
                    ? "أنشئ مساحة عملك، فعّل خطتك، واربط أودو خلال دقائق."
                    : "Create your workspace, activate a plan, and bind Odoo in minutes."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  size="lg"
                  href="/signup"
                  icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
                >
                  {t("home.ctaPrimary")}
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  href="/login"
                >
                  {t("auth.signIn.submit")}
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* Minimal Footer */}
        <footer className="border-t border-edge-subtle py-10">
          <div className="mx-auto flex w-full max-w-[1120px] flex-col items-center justify-between gap-5 px-5 sm:flex-row sm:px-8 lg:px-10">
            <BrandMark title="Yaseir" subtitle="Print Manager" size="sm" showWordmark />
            <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-ink-3">
              <Link
                href="/pricing"
                className="inline-flex min-h-11 items-center rounded-sm px-1 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                {t("home.navPricing")}
              </Link>
              <Link
                href="/login"
                className="inline-flex min-h-11 items-center rounded-sm px-1 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                {t("auth.signIn.submit")}
              </Link>
              <Link
                href="/signup"
                className="inline-flex min-h-11 items-center rounded-sm px-1 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
              >
                {t("home.ctaPrimary")}
              </Link>
              <span>© {new Date().getFullYear()} Yaseir</span>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}

function PublicHeader({ t }: { t: Translator }) {
  return (
    <header className="yw-public-header sticky top-0 z-40 border-b border-edge-subtle">
      <div className="mx-auto flex h-16 w-full max-w-[1120px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          aria-label={t("home.brandAria")}
          className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        >
          <BrandMark title="Yaseir" subtitle="Print Manager" size="sm" showWordmark className="yw-public-brand-mark" />
        </Link>
        <nav aria-label={t("home.primaryNavigation")} className="ms-auto hidden flex-nowrap items-center gap-0.5 xl:flex">
          <a href="#how-it-works" className="yw-public-nav-link">{t("home.navHowItWorks")}</a>
          <Link href="/pricing" className="yw-public-nav-link">{t("home.navPricing")}</Link>
        </nav>
        <div className="ms-auto hidden shrink-0 items-center gap-2 xl:flex">
          <Link href="/login" className="yw-public-nav-link">{t("auth.signIn.submit")}</Link>
          <LanguageSwitcher compact placement="below" />
          <ThemeToggle />
          <Button variant="primary" size="md" href="/signup" className="whitespace-nowrap">{t("home.ctaPrimary")}</Button>
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-2 xl:hidden">
          <Button variant="primary" size="md" href="/signup" className="whitespace-nowrap">{t("home.ctaPrimary")}</Button>
          <MobileNavigation
            menuLabel={t("home.navMenu")}
            closeLabel={t("ui.closeDialog")}
            languageLabel={t("common.language")}
            items={[
              { href: "#how-it-works", label: t("home.navHowItWorks") },
              { href: "/pricing", label: t("home.navPricing") },
              { href: "/login", label: t("auth.signIn.submit") },
            ]}
          />
        </div>
      </div>
    </header>
  );
}

function PillarCard({
  icon,
  title,
  lead,
}: {
  icon: ReactNode;
  title: string;
  lead: string;
}) {
  return (
    <div className="border-t-2 border-brand/25 pt-5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-subtle text-brand">
        {icon}
      </span>
      <h2 className="mt-4 text-lg font-[500] text-ink">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{lead}</p>
    </div>
  );
}

/* ============================================================
   Signed-in landing — Apple iOS 27 minimal workspace overview
   ============================================================ */

function AuthenticatedHome({
  t,
  locale,
  tenantName,
  role,
  planName,
  subscriptionStatus,
  periodEnd,
  canBilling,
  canTeam,
}: {
  t: Translator;
  locale: Locale;
  tenantName: string;
  role: string;
  planName: string | null;
  subscriptionStatus: ReturnType<typeof customerSubscriptionState>;
  periodEnd: Date | null;
  canBilling: boolean;
  canTeam: boolean;
}) {
  const hasPlan = !!planName && subscriptionStatus === "active";
  const statusTone: Tone = subscriptionStatus === "active" ? "ok" : subscriptionStatus === "suspended" ? "bad" : "warn";
  const statusKey = {
    active: "v4.onboarding.active",
    awaiting_activation: "v4.onboarding.pending",
    expired: "v4.onboarding.expired",
    suspended: "v4.onboarding.suspended",
  } as const;

  return (
    <div className="mx-auto w-full max-w-[1040px] px-5 py-12 sm:px-8 sm:py-16">
      <section className="glass-card overflow-hidden">
        <div className="flex flex-col gap-5 p-6 sm:p-8">
          <div className="min-w-0">
            <p className="text-eyebrow">{t("home.authWorkspace")}</p>
            <h1 className="mt-2 text-[2rem] font-[500] text-ink">{tenantName}</h1>
            <p className="mt-1.5 text-sm text-ink-2">
              {t("home.authSignedInAs")} <span className="font-semibold text-ink">{roleLabel(role, t)}</span>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2.5">
            <Button variant="primary" href="/dashboard" icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}>
              {t("home.authOpenConsole")}
            </Button>
            {canBilling && (
              <Button variant="secondary" href="/billing" icon={<CreditCard className="h-4 w-4" />}>
                {t("v4.subscription.title")}
              </Button>
            )}
          </div>
        </div>

        <dl className={`grid gap-3 border-t border-edge-subtle bg-surface/30 p-4 sm:p-6 ${canBilling ? "sm:grid-cols-3" : ""}`}>
          {canBilling && (
            <div className="rounded-xl border border-edge-subtle bg-surface/60 px-5 py-4">
              <dt className="label-caps">{t("home.planLabel")}</dt>
              <dd className="mt-1.5 text-sm font-semibold text-ink">{hasPlan ? planName : t("billing.noPlanSelected")}</dd>
            </div>
          )}
          <div className="rounded-xl border border-edge-subtle bg-surface/60 px-5 py-4">
            <dt className="label-caps">{t("home.subscriptionLabel")}</dt>
            <dd className="mt-1.5">
              <StatusBadge tone={statusTone} label={t(statusKey[subscriptionStatus])} />
            </dd>
          </div>
          {canBilling && (
            <div className="rounded-xl border border-edge-subtle bg-surface/60 px-5 py-4">
              <dt className="label-caps">{t("v4.subscription.end")}</dt>
              <dd className="mt-1.5 text-sm font-semibold tabular-nums text-ink">
                {formatManualCalendarDate(periodEnd, locale) ?? t("common.notAvailable")}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="mt-5 grid gap-4 md:grid-cols-3">
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
            icon={<Settings className="h-4 w-4" />}
            title={t("home.quickSettingsTitle")}
            text={t("home.quickSettingsText")}
            meta={t("home.quickSettingsMeta")}
            t={t}
          />
        )}
      </section>
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
      className="group glass-card-interactive flex flex-col justify-between p-6 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand/35 focus-visible:ring-offset-[3px] focus-visible:ring-offset-app"
    >
      <div>
        <div className="flex items-center justify-between">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-edge bg-surface-2 text-brand">
            {icon}
          </span>
          <ArrowRight
            className="h-4 w-4 text-ink-3 transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
            aria-hidden="true"
          />
        </div>
        <h2 className="mt-4 text-base font-[500] text-ink">{title}</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{text}</p>
      </div>
      <div className="mt-5 border-t border-edge-subtle pt-3">
        <p className="text-2xs text-ink-3">
          <span className="font-medium text-ink-2">{meta}</span>
          {" · "}
          {t("home.quickLinkOpen")}
        </p>
      </div>
    </Link>
  );
}
