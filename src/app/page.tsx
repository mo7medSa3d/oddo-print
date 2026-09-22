import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../db";
import { plans, tenantSubscriptions, tenants } from "../db/schema";
import { eq } from "drizzle-orm";
import { ThemeToggle } from "../components/ThemeToggle";
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronRight,
  CircleCheck,
  CreditCard,
  KeyRound,
  Layers3,
  LockKeyhole,
  Network,
  PackageCheck,
  Printer,
  ReceiptText,
  Server,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Users,
  Waypoints,
  Zap,
} from "lucide-react";
import { BrandMark } from "../components/brand";
import {
  getManagerCookieName,
  validateManagerClaims,
  verifyManagerToken,
} from "../lib/manager-auth";
import { hasManagerPermission } from "../lib/authorization";

export const dynamic = "force-dynamic";

export default async function Home() {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);

  if (claims) {
    const [tenant, subscription] = await Promise.all([
      db.query.tenants.findFirst({
        where: eq(tenants.id, claims.tenantId),
        columns: { name: true },
      }),
      db.query.tenantSubscriptions.findFirst({
        where: eq(tenantSubscriptions.tenantId, claims.tenantId),
        columns: { planId: true, status: true, currentPeriodEnd: true },
      }),
    ]);

    const plan = subscription
      ? await db.query.plans.findFirst({
          where: eq(plans.id, subscription.planId),
          columns: { name: true },
        })
      : null;

    return (
      <AuthenticatedHome
        tenantName={tenant?.name ?? "Workspace"}
        role={claims.role}
        planName={plan?.name ?? null}
        subscriptionStatus={subscription?.status ?? null}
        periodEnd={subscription?.currentPeriodEnd ?? null}
        canBilling={hasManagerPermission(claims, "billing.read")}
        canTeam={hasManagerPermission(claims, "users.read")}
      />
    );
  }

  return <PublicHome />;
}

function PublicHome() {
  return (
    <div className="overflow-x-hidden">
      <PublicHeader />

      <main>
        <section className="relative border-b border-edge bg-app">
          <div className="mx-auto grid w-full max-w-[1320px] gap-14 px-6 pb-20 pt-8 sm:px-8 sm:pb-24 sm:pt-10 lg:grid-cols-[0.96fr_1.04fr] lg:items-center lg:gap-16 lg:px-10 lg:pb-28 lg:pt-12">
            <div className="max-w-[650px]">
              <div className="inline-flex items-center gap-2 rounded-full border border-edge-accent bg-brand-subtle px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] text-brand-subtle-text">
                <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                Odoo 19 • Automated printing for stores, warehouses & offices
              </div>

              <h1 className="mt-7 max-w-[680px] text-[45px] font-bold tracking-[-0.045em] leading-[0.98] text-ink sm:text-[58px] lg:text-[68px]">
                Print from Odoo without the browser.
                <span className="block text-brand">Every document. The right printer.</span>
              </h1>

              <p className="mt-6 max-w-[590px] text-[17px] leading-[1.72] text-ink-2 sm:text-[18px]">
                Yasser Gateway routes invoices, receipts, labels, and reports from Odoo to the right local printer automatically.
                Keep business rules in Odoo and let the Gateway handle delivery across branches, stores, and warehouses.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/signup"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-brand px-6 text-[14px] font-semibold text-white shadow-sm transition hover:bg-brand-hover"
                >
                  Start your free trial
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="#how-it-works"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-edge bg-surface px-6 text-[14px] font-semibold text-ink transition hover:border-edge-strong hover:bg-surface-2"
                >
                  See how it works
                  <ArrowUpRight className="h-4 w-4" />
                </Link>
              </div>

              <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-2.5 text-[11.5px] font-medium text-ink-3">
                <TrustItem icon={<ShieldCheck className="h-3.5 w-3.5" />} text="No browser dialogs" />
                <TrustItem icon={<Zap className="h-3.5 w-3.5" />} text="Branch-aware routing" />
                <TrustItem icon={<LockKeyhole className="h-3.5 w-3.5" />} text="Local Windows execution" />
                <TrustItem icon={<CircleCheck className="h-3.5 w-3.5" />} text="Track every job" />
              </div>
            </div>

            <GatewayHeroVisual />
          </div>
        </section>

        <section id="product" className="scroll-mt-20 bg-surface">
          <div className="mx-auto w-full max-w-[1320px] px-6 py-20 sm:px-8 sm:py-24 lg:px-10">
            <SectionIntro
              eyebrow="Built for Odoo"
              title="One managed path from Odoo to paper."
              text="Automate everyday printing across offices, stores, warehouses, and branches — without relying on browser print dialogs or manual handoffs."
            />

            <div className="mt-12 grid gap-4 lg:grid-cols-3">
              <ProductCard
                icon={<ReceiptText className="h-5 w-5" />}
                title="Invoices & documents"
                text="Send invoices, reports, sales documents, and delivery paperwork to the printer assigned to the job."
                items={["Odoo reports", "Invoice & sales documents", "Document-based routing"]}
              />
              <ProductCard
                icon={<ShoppingCart className="h-5 w-5" />}
                title="POS & counter printing"
                text="Print receipts where the order belongs, keep reprints tied to the original job, and remove the browser from the counter."
                items={["POS receipts", "Safe reprints", "Restaurant print paths"]}
              />
              <ProductCard
                icon={<PackageCheck className="h-5 w-5" />}
                title="Warehouse & labels"
                text="Keep labels and operational documents close to the work with branch-aware printer assignments and local execution."
                items={["Stock operations", "Labels & raw output", "Branch-aware routing"]}
              />
            </div>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-20 border-y border-edge bg-app">
          <div className="mx-auto grid w-full max-w-[1320px] gap-12 px-6 py-20 sm:px-8 sm:py-24 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20 lg:px-10">
            <div>
              <SectionIntro
                eyebrow="How it works"
                title="From Odoo to paper, without the browser in the middle."
                text="Odoo decides what should print. The Gateway manages delivery. The Windows Agent runs the job locally. The printer does the rest."
              />
              <div className="mt-8 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-4">
                <span>Business intent</span>
                <ArrowRight className="h-3.5 w-3.5" />
                <span>Runtime delivery</span>
                <ArrowRight className="h-3.5 w-3.5" />
                <span>Physical execution</span>
              </div>
            </div>

            <ol className="space-y-3">
              <FlowRow number="01" icon={<Layers3 className="h-4 w-4" />} title="Odoo" text="Creates the print job with the business and routing context." />
              <FlowRow number="02" icon={<Network className="h-4 w-4" />} title="Gateway" text="Queues, routes, and tracks every job until the delivery outcome is known." />
              <FlowRow number="03" icon={<Server className="h-4 w-4" />} title="Windows Agent" text="Runs the job on the local Windows machine and reports the result back to the Gateway." />
              <FlowRow number="04" icon={<Printer className="h-4 w-4" />} title="Printer" text="Prints through the available local connection and returns the delivery result." />
            </ol>
          </div>
        </section>

        <section id="reliability" className="scroll-mt-20 bg-surface">
          <div className="mx-auto w-full max-w-[1320px] px-6 py-20 sm:px-8 sm:py-24 lg:px-10">
            <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr] lg:items-start">
              <SectionIntro
                eyebrow="Reliability"
                title="Built for busy branches, not perfect networks."
                text="Printers go offline. Connections drop. Agents restart. The Gateway keeps the print workflow moving and makes the delivery state clear."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <ReliabilityCard title="Jobs stay queued" text="A temporary network or printer issue does not erase the work waiting to print." icon={<Boxes className="h-5 w-5" />} />
                <ReliabilityCard title="Duplicate-safe retries" text="Retries keep the same job identity, so recovery does not become a second logical print." icon={<Waypoints className="h-5 w-5" />} />
                <ReliabilityCard title="Stale delivery blocked" text="When ownership changes, an old delivery attempt cannot later overwrite the real job outcome." icon={<LockKeyhole className="h-5 w-5" />} />
                <ReliabilityCard title="Honest status" text="When physical output cannot be proven, the system says so instead of claiming success." icon={<ShieldCheck className="h-5 w-5" />} />
              </div>
            </div>
          </div>
        </section>

        <section id="security" className="scroll-mt-20 border-y border-edge bg-app">
          <div className="mx-auto w-full max-w-[1320px] px-6 py-20 sm:px-8 sm:py-24 lg:px-10">
            <SectionIntro
              eyebrow="Security & visibility"
              title="Built for controlled, business-critical printing."
              text="Keep access scoped, track delivery, and see what happened to every print job across the workspace."
            />

            <div className="mt-12 grid gap-4 lg:grid-cols-2">
              <SecurityPanel
                title="Controlled Odoo access"
                icon={<KeyRound className="h-5 w-5" />}
                items={[
                  "Each Odoo integration uses its own scoped API credential.",
                  "Access can be limited by key scope and document type.",
                  "Keep Odoo access separate from browser print sessions.",
                ]}
              />
              <SecurityPanel
                title="Operational visibility"
                icon={<Sparkles className="h-5 w-5" />}
                items={[
                  "See connected Agents and available printers from one console.",
                  "Track every job from queue to delivery outcome.",
                  "Keep workspace changes and ownership history auditable.",
                ]}
              />
            </div>
          </div>
        </section>

        <section className="bg-surface">
          <div className="mx-auto w-full max-w-[1320px] px-6 py-20 sm:px-8 sm:py-24 lg:px-10">
            <div className="rounded-[24px] border border-edge-strong bg-surface-2 p-7 shadow-card sm:p-10 lg:p-12">
              <div className="grid gap-10 lg:grid-cols-[1fr_auto] lg:items-end">
                <div className="max-w-[760px]">
                  <div className="inline-flex items-center gap-2 rounded-full border border-edge-accent bg-brand-subtle px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] text-brand-subtle-text">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                    Built for everyday operations
                  </div>
                  <h2 className="mt-5 text-[32px] font-bold tracking-[-0.035em] leading-[1.04] text-ink sm:text-[42px]">
                    Make printing part of the workflow.
                  </h2>
                  <p className="mt-4 max-w-[660px] text-[15px] leading-relaxed text-ink-3 sm:text-[16px]">
                    Connect Odoo, register the Windows Agent, assign printers by branch, and let Yasser handle the delivery path from business event to physical output.
                  </p>
                </div>

                <div className="flex flex-col gap-2.5 sm:flex-row lg:flex-col">
                  <Link
                    href="/signup"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 text-[13px] font-semibold text-white transition hover:bg-brand-hover"
                  >
                    Create workspace
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/pricing"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-edge bg-surface px-5 text-[13px] font-semibold text-ink transition hover:border-edge-strong hover:bg-surface-3"
                  >
                    View plans
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

function PublicHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-edge/80 bg-app/75 backdrop-blur-xl backdrop-saturate-180">
      <div className="mx-auto flex h-[68px] w-full max-w-[1320px] items-center gap-5 px-6 sm:px-8 lg:px-10">
        <Link href="/" className="shrink-0 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25">
          <BrandMark title="Yasser" subtitle="Print Manager" size="sm" showWordmark />
        </Link>
        <nav className="hidden min-w-0 flex-1 items-center gap-1 md:flex" aria-label="Landing page">
          <Anchor href="#product">Product</Anchor>
          <Anchor href="#how-it-works">How it works</Anchor>
          <Anchor href="#reliability">Reliability</Anchor>
          <Anchor href="#security">Security</Anchor>
          <Link href="/pricing" className="inline-flex h-10 items-center rounded-full px-3 text-[12.5px] font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink">
            Pricing
          </Link>
        </nav>

        <ThemeToggle />

        <details className="relative md:hidden">
          <summary className="flex h-10 list-none cursor-pointer items-center justify-center rounded-full border border-edge bg-surface px-3 text-[12px] font-semibold text-ink-2 transition hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
            Menu
          </summary>
          <div className="absolute right-0 top-12 z-50 w-56 rounded-[14px] border border-edge-strong bg-surface p-2 shadow-xl">
            <div className="space-y-1">
              <Anchor href="#product">Product</Anchor>
              <Anchor href="#how-it-works">How it works</Anchor>
              <Anchor href="#reliability">Reliability</Anchor>
              <Anchor href="#security">Security</Anchor>
              <Link href="/pricing" className="flex h-10 items-center rounded-full px-3 text-[12.5px] font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink">
                Pricing
              </Link>
              <Link href="/login" className="flex h-10 items-center rounded-full px-3 text-[12.5px] font-semibold text-ink-2 transition hover:bg-surface-2 hover:text-ink sm:hidden">
                Sign in
              </Link>
            </div>
          </div>
        </details>

        <div className="ml-auto hidden items-center gap-2.5 md:flex">
          <Link href="/login" className="hidden h-10 items-center rounded-full px-3.5 text-[12.5px] font-semibold text-ink-2 transition hover:bg-surface-2 hover:text-ink sm:inline-flex">
            Sign in
          </Link>
          <Link href="/signup" className="inline-flex h-10 items-center gap-2 rounded-full bg-brand px-4 text-[12.5px] font-semibold text-white transition hover:bg-brand-hover">
            Start trial
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="border-t border-edge bg-surface-2">
      <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-6 px-6 py-10 sm:px-8 lg:flex-row lg:items-end lg:justify-between lg:px-10">
        <div>
          <BrandMark title="Yasser" subtitle="Print Manager" size="sm" showWordmark />
          <p className="mt-3 max-w-[420px] text-[12px] leading-relaxed text-ink-4">
            Automated Odoo printing for receipts, invoices, labels, and reports — delivered to the right printer across your operation.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11.5px] font-medium text-ink-3">
          <Link href="/pricing" className="transition hover:text-ink">Pricing</Link>
          <Link href="/login" className="transition hover:text-ink">Sign in</Link>
          <Link href="/signup" className="transition hover:text-ink">Create account</Link>
          <span className="text-ink-4">Odoo 19</span>
        </div>
      </div>
    </footer>
  );
}

function Anchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="inline-flex h-10 items-center rounded-full px-3 text-[12.5px] font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink">
      {children}
    </a>
  );
}

function TrustItem({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-brand">{icon}</span>
      {text}
    </span>
  );
}

function GatewayHeroVisual() {
  return (
    <div className="relative">

      <div className="absolute -inset-5 rounded-[30px] border border-brand/10" aria-hidden />
      <div className="relative overflow-hidden rounded-[22px] border border-edge-strong bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge bg-surface-2/70 px-4 py-3.5 sm:px-5">
          <div className="flex items-center gap-2.5">
            <BrandMark title="Yasser Gateway" subtitle="Print operations" size="sm" />
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-ok-edge bg-ok-bg px-2.5 py-1 text-[10px] font-semibold text-ok">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok-solid" />
            Operational
          </span>
        </div>

        <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[1fr_0.92fr]">
          <div className="space-y-3">
            <ConsoleCard label="The print path">
              <div className="space-y-2">
                <RuntimeNode icon={<Layers3 className="h-3.5 w-3.5" />} title="Odoo" meta="Business intent stays in ERP" />
                <RuntimeConnector />
                <RuntimeNode icon={<Network className="h-3.5 w-3.5" />} title="Gateway" meta="Durable queue + routing" active />
                <RuntimeConnector />
                <RuntimeNode icon={<Server className="h-3.5 w-3.5" />} title="Windows Agent" meta="Edge execution + fencing" />
                <RuntimeConnector />
                <RuntimeNode icon={<Printer className="h-3.5 w-3.5" />} title="Printer" meta="Spooler / raw / USB output" />
              </div>
            </ConsoleCard>

            <div className="flex flex-wrap gap-2">
              <HeroPill icon={<Zap className="h-3 w-3" />} text="No browser dialogs" />
              <HeroPill icon={<ShieldCheck className="h-3 w-3" />} text="Branch aware" />
              <HeroPill icon={<LockKeyhole className="h-3 w-3" />} text="Tracked delivery" />
            </div>
          </div>

          <div className="space-y-3">
            <ConsoleCard label="What your team gets">
              <ul className="space-y-2.5">
                <HeroCheck text="No browser dialogs at the counter" />
                <HeroCheck text="Route jobs to the right branch printer" />
                <HeroCheck text="Know what happened to every job" />
              </ul>
            </ConsoleCard>

            <div className="rounded-[14px] border border-edge-accent bg-surface-accent p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-subtle-text">Built for daily operations</div>
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                <HeroMetric value="Queued" label="jobs stay recoverable" />
                <HeroMetric value="Routed" label="by branch and printer" />
                <HeroMetric value="Local" label="Windows Agent execution" />
                <HeroMetric value="Tracked" label="delivery status preserved" />
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-edge bg-surface-2/50 px-4 py-3 text-[10px] text-ink-4 sm:px-5">
          Queued jobs • branch routing • local execution • delivery tracking
        </div>
      </div>
    </div>
  );
}

function ConsoleCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-[14px] border border-edge bg-surface-2/55 p-4">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-4">{label}</div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function HeroPill({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-2/70 px-2.5 py-1.5 text-[10px] font-semibold text-ink-2">
      <span className="text-brand">{icon}</span>
      {text}
    </span>
  );
}

function HeroCheck({ text }: { text: string }) {
  return (
    <li className="flex items-center gap-2 text-[12px] font-medium text-ink-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok-bg text-ok">
        <Check className="h-3 w-3" />
      </span>
      <span>{text}</span>
    </li>
  );
}

function RuntimeNode({ icon, title, meta, active }: { icon: ReactNode; title: string; meta: string; active?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5 ${active ? "border-edge-accent bg-brand-subtle" : "border-edge bg-surface"}`}>
      <span className={`flex h-7 w-7 items-center justify-center rounded-[8px] border ${active ? "border-edge-accent bg-brand/10 text-brand" : "border-edge bg-surface-2 text-ink-3"}`}>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[11.5px] font-semibold text-ink">{title}</div>
        <div className="text-[9.5px] text-ink-4">{meta}</div>
      </div>
      <span className={`ml-auto h-1.5 w-1.5 rounded-full ${active ? "bg-ok-solid animate-pulse" : "bg-ink-4"}`} />
    </div>
  );
}

function RuntimeConnector() {
  return <div className="ml-[13px] h-3 border-l border-dashed border-edge-strong" aria-hidden />;
}

function HeroMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-[9px] border border-edge bg-surface/70 px-3 py-2.5">
      <div className="text-[14px] font-bold tracking-[-0.02em] text-ink">{value}</div>
      <div className="mt-0.5 text-[8.5px] leading-snug text-ink-4">{label}</div>
    </div>
  );
}

function SectionIntro({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return (
    <div className="max-w-[700px]">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.13em] text-brand">{eyebrow}</div>
      <h2 className="mt-3 text-[29px] font-bold tracking-[-0.035em] leading-[1.08] text-ink sm:text-[38px]">{title}</h2>
      <p className="mt-4 max-w-[650px] text-[14.5px] leading-[1.72] text-ink-3 sm:text-[15.5px]">{text}</p>
    </div>
  );
}

function ProductCard({ icon, title, text, items }: { icon: ReactNode; title: string; text: string; items: string[] }) {
  return (
    <article className="rounded-[16px] border border-edge bg-surface p-5 shadow-card transition duration-200 hover:-translate-y-px hover:border-edge-strong hover:shadow-card-hover sm:p-6">
      <div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-edge-accent bg-brand-subtle text-brand">{icon}</div>
      <h3 className="mt-5 text-[17px] font-semibold tracking-[-0.02em] text-ink">{title}</h3>
      <p className="mt-2.5 text-[13px] leading-relaxed text-ink-3">{text}</p>
      <div className="mt-5 space-y-2">
        {items.map((item) => (
          <div key={item} className="flex items-center gap-2 text-[11.5px] font-medium text-ink-2">
            <Check className="h-3.5 w-3.5 text-ok" />
            <span>{item}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function FlowRow({ number, icon, title, text }: { number: string; icon: ReactNode; title: string; text: string }) {
  return (
    <li className="group flex gap-4 rounded-[14px] border border-edge bg-surface p-4 transition hover:border-edge-strong hover:bg-surface-2/65 sm:p-5">
      <div className="flex w-10 shrink-0 flex-col items-center gap-2">
        <span className="font-mono text-[10px] font-bold tracking-[0.08em] text-brand">{number}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-[9px] border border-edge bg-surface-2 text-ink-3 group-hover:border-edge-accent group-hover:text-brand">{icon}</span>
      </div>
      <div className="pt-0.5">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">{text}</p>
      </div>
    </li>
  );
}

function ReliabilityCard({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <article className="rounded-[15px] border border-edge bg-surface p-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-[9px] border border-edge-accent bg-brand-subtle text-brand">{icon}</div>
      <h3 className="mt-4 text-[15px] font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">{text}</p>
    </article>
  );
}

function SecurityPanel({ icon, title, items }: { icon: ReactNode; title: string; items: string[] }) {
  return (
    <article className="rounded-[16px] border border-edge bg-surface p-6">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-[9px] border border-edge-accent bg-brand-subtle text-brand">{icon}</span>
        <h3 className="text-[16px] font-semibold text-ink">{title}</h3>
      </div>
      <div className="mt-6 space-y-3">
        {items.map((item) => (
          <div key={item} className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-2">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
            <span>{item}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function AuthenticatedHome({
  tenantName,
  role,
  planName,
  subscriptionStatus,
  periodEnd,
  canBilling,
  canTeam,
}: {
  tenantName: string;
  role: string;
  planName: string | null;
  subscriptionStatus: string | null;
  periodEnd: Date | null;
  canBilling: boolean;
  canTeam: boolean;
}) {
  const hasPlan = !!planName && !!subscriptionStatus && subscriptionStatus !== "cancelled";

  return (
    <div className="mx-auto w-full max-w-[1280px] px-6 py-8">
      <section className="billing-premium p-7 sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              <span className="h-1.5 w-1.5 rounded-full bg-ok-solid" /> Workspace
            </div>
            <h1 className="mt-4 text-[28px] font-bold tracking-[-0.02em] text-ink">Welcome back</h1>
            <p className="mt-2 text-[16px] text-ink-2">{tenantName}</p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <Link href="/dashboard" className="inline-flex h-10 items-center gap-2 rounded-full bg-brand px-5 text-[13px] font-semibold text-white shadow-sm hover:bg-brand-hover">
              Open console <ArrowRight className="h-4 w-4" />
            </Link>
            {canBilling && <Link href="/billing" className="inline-flex h-10 items-center gap-2 rounded-full border border-edge bg-surface px-5 text-[13px] font-semibold text-ink hover:bg-surface-2">Billing</Link>}
          </div>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          <StatusItem label="Plan" value={hasPlan ? planName! : "No plan"} icon={<CreditCard className="h-4 w-4" />} />
          <StatusItem label="Subscription" value={subscriptionStatus ? formatStatus(subscriptionStatus) : "Not configured"} icon={<ShieldCheck className="h-4 w-4" />} />
          <StatusItem label="Role" value={role} icon={<Users className="h-4 w-4" />} />
        </div>
        {periodEnd && <p className="mt-5 text-[12px] text-ink-3">Current period ends {periodEnd.toLocaleDateString()}.</p>}
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-3">
        <QuickLink href="/dashboard" icon={<Server className="h-5 w-5" />} title="Console" text="Manage agents, printers, jobs — operational dashboard." badge={`${hasPlan ? planName : "Setup needed"}`} />
        <QuickLink href="/api-keys" icon={<KeyRound className="h-5 w-5" />} title="Odoo integration" text="Odoo credentials, activation state, connection health — separated." badge="Integration" />
        {canTeam ? <QuickLink href="/team" icon={<Users className="h-5 w-5" />} title="Team" text="Members, roles, ownership transfer — RBAC enforced." badge="Admin" /> : <QuickLink href="/settings" icon={<Settings className="h-5 w-5" />} title="Settings" text="Workspace identity and control center." badge="General" />}
      </section>

      <div className="mt-10 flex items-center justify-center gap-2 text-[11px] text-ink-3">
        <span>Odoo</span><ArrowRight className="h-3 w-3" /><span>Gateway</span><ArrowRight className="h-3 w-3" /><span>Windows Agent</span><ArrowRight className="h-3 w-3" /><span>Printer</span>
      </div>
    </div>
  );
}

function StatusItem({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-[12px] border border-edge bg-surface-2/80 px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-[8px] bg-surface border border-edge text-ink-3">{icon}</span>
        {label}
      </div>
      <div className="mt-2.5 text-[14px] font-semibold text-ink">{value}</div>
    </div>
  );
}

function QuickLink({ href, icon, title, text, badge }: { href: string; icon: ReactNode; title: string; text: string; badge: string }) {
  return (
    <Link href={href} className="group relative overflow-hidden rounded-[14px] border border-edge bg-surface p-5 shadow-card transition-all hover:shadow-card-hover hover:border-edge-strong hover:-translate-y-[1px]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-edge-accent bg-brand-subtle text-brand">{icon}</div>
        <span className="inline-flex items-center gap-1 rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-ink-3">{badge} <ArrowUpRight className="h-3 w-3 opacity-60 group-hover:opacity-100 transition" /></span>
      </div>
      <h2 className="mt-4 text-[14px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">{text}</p>
    </Link>
  );
}

function formatStatus(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
