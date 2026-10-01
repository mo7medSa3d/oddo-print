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
  Check,
  ChevronRight,
} from "lucide-react";
import { BrandMark } from "../components/brand";
import {
  getManagerCookieName,
  verifyWorkspaceTokenFromCookieValues,
} from "../lib/manager-auth";
import { hasManagerPermission } from "../lib/authorization";

export const dynamic = "force-dynamic";

export default async function Home() {
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
        <section className="border-b border-edge bg-app">
          <div className="mx-auto grid w-full max-w-[1200px] gap-12 px-6 pb-16 pt-10 sm:px-8 sm:pb-20 sm:pt-14 lg:grid-cols-[1fr_1fr] lg:items-start lg:gap-14 lg:px-8 lg:pb-24">
            <div className="max-w-[600px]">
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">
                Odoo 19 · Automated printing for stores, warehouses and offices
              </p>

              <h1 className="mt-4 max-w-[600px] text-[36px] font-bold leading-[1.08] tracking-[-0.03em] text-ink sm:text-[44px]">
                Print from Odoo without the browser dialog.
              </h1>

              <p className="mt-4 max-w-[560px] text-[15px] leading-[1.7] text-ink-2">
                Yaseir Gateway routes invoices, receipts, labels, and reports from Odoo to the right local printer automatically.
                Keep business rules in Odoo and let the Gateway handle delivery across branches, stores, and warehouses.
              </p>

              <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
                <Link
                  href="/signup"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[8px] bg-brand px-5 text-[14px] font-semibold text-white transition hover:bg-brand-hover"
                >
                  Start your free trial
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="#how-it-works"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[8px] border border-edge-strong bg-surface px-5 text-[14px] font-semibold text-ink transition hover:bg-surface-2"
                >
                  See how it works
                  <ArrowUpRight className="h-4 w-4" />
                </Link>
              </div>

              <dl className="mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-edge bg-edge sm:grid-cols-2">
                <TrustCell title="No browser dialogs" text="Counter and back-office printing without pop-ups." />
                <TrustCell title="Branch-aware routing" text="Route by branch, printer and document type." />
                <TrustCell title="Local Windows execution" text="Agent runs the job on the local machine." />
                <TrustCell title="Delivery tracking" text="Queue, delivery and outcome stay visible." />
              </dl>
            </div>

            <GatewayHeroVisual />
          </div>
        </section>

        <section id="product" className="scroll-mt-20 border-b border-edge bg-surface">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 sm:px-8 sm:py-20 lg:px-8">
            <SectionIntro
              eyebrow="Product"
              title="One managed path from Odoo to paper."
              text="Automate everyday printing across offices, stores, warehouses, and branches — without relying on browser print dialogs or manual handoffs."
            />

            <div className="mt-10 grid gap-px overflow-hidden rounded-[10px] border border-edge bg-edge lg:grid-cols-3">
              <ProductCard
                title="Invoices and documents"
                text="Send invoices, reports, sales documents, and delivery paperwork to the printer assigned to the job."
                items={["Odoo reports", "Invoice and sales documents", "Document-based routing"]}
              />
              <ProductCard
                title="POS and counter printing"
                text="Print receipts where the order belongs, keep reprints tied to the original job, and remove the browser from the counter."
                items={["POS receipts", "Safe reprints", "Counter print paths"]}
              />
              <ProductCard
                title="Warehouse and labels"
                text="Keep labels and operational documents close to the work with branch-aware assignments and local execution."
                items={["Stock operations", "Labels and raw output", "Branch-aware routing"]}
              />
            </div>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-20 border-b border-edge bg-app">
          <div className="mx-auto grid w-full max-w-[1200px] gap-10 px-6 py-16 sm:px-8 sm:py-20 lg:grid-cols-[0.9fr_1.1fr] lg:gap-14 lg:px-8">
            <div>
              <SectionIntro
                eyebrow="How it works"
                title="From Odoo to paper, without the browser in the middle."
                text="Odoo decides what should print. The Gateway manages delivery. The Windows Agent runs the job locally. The printer does the rest."
              />
              <p className="mt-6 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">
                Business intent → Runtime delivery → Physical execution
              </p>
            </div>

            <ol className="divide-y divide-edge rounded-[10px] border border-edge bg-surface">
              <FlowRow number="01" title="Odoo" text="Creates the print job with the business and routing context." />
              <FlowRow number="02" title="Gateway" text="Queues, routes, and tracks every job until the delivery outcome is known." />
              <FlowRow number="03" title="Windows Agent" text="Runs the job on the local Windows machine and reports the result back to the Gateway." />
              <FlowRow number="04" title="Printer" text="Prints through the available local connection and returns the delivery result." />
            </ol>
          </div>
        </section>

        <section id="reliability" className="scroll-mt-20 border-b border-edge bg-surface">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 sm:px-8 sm:py-20 lg:px-8">
            <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
              <SectionIntro
                eyebrow="Reliability"
                title="Built for busy branches, not perfect networks."
                text="Printers go offline. Connections drop. Agents restart. The Gateway keeps the print workflow moving and makes the delivery state clear."
              />
              <dl className="grid gap-px overflow-hidden rounded-[10px] border border-edge bg-edge sm:grid-cols-2">
                <ReliabilityCell title="Jobs stay queued" text="A temporary network or printer issue does not erase the work waiting to print." />
                <ReliabilityCell title="Duplicate-safe retries" text="Retries keep the same job identity, so recovery does not become a second logical print." />
                <ReliabilityCell title="Stale delivery blocked" text="When ownership changes, an old delivery attempt cannot later overwrite the real job outcome." />
                <ReliabilityCell title="Honest status" text="When physical output cannot be proven, the system says so instead of claiming success." />
              </dl>
            </div>
          </div>
        </section>

        <section id="security" className="scroll-mt-20 border-b border-edge bg-app">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 sm:px-8 sm:py-20 lg:px-8">
            <SectionIntro
              eyebrow="Security and visibility"
              title="Controlled printing for business operations."
              text="Keep access scoped, track delivery, and see what happened to every print job across the workspace."
            />

            <div className="mt-10 grid gap-px overflow-hidden rounded-[10px] border border-edge bg-edge lg:grid-cols-2">
              <SecurityPanel
                title="Controlled Odoo access"
                items={[
                  "Each Odoo integration uses its own scoped API credential.",
                  "Access can be limited by key scope and document type.",
                  "Keep Odoo access separate from browser print sessions.",
                ]}
              />
              <SecurityPanel
                title="Operational visibility"
                items={[
                  "See connected agents and available printers from one console.",
                  "Track every job from queue to delivery outcome.",
                  "Keep workspace changes and ownership history auditable.",
                ]}
              />
            </div>
          </div>
        </section>

        <section className="bg-surface">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 sm:px-8 sm:py-20 lg:px-8">
            <div className="rounded-[10px] border border-edge bg-surface-2 px-6 py-8 sm:px-8">
              <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
                <div className="max-w-[640px]">
                  <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">
                    Operations
                  </p>
                  <h2 className="mt-3 text-[26px] font-bold leading-[1.15] tracking-[-0.02em] text-ink sm:text-[30px]">
                    Make printing part of the workflow.
                  </h2>
                  <p className="mt-3 max-w-[600px] text-[14px] leading-relaxed text-ink-2">
                    Connect Odoo, register the Windows Agent, assign printers by branch, and let Yaseir handle the delivery path from business event to physical output.
                  </p>
                </div>

                <div className="flex flex-col gap-2.5 sm:flex-row lg:flex-col lg:items-stretch">
                  <Link
                    href="/signup"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[8px] bg-brand px-5 text-[13px] font-semibold text-white transition hover:bg-brand-hover"
                  >
                    Create workspace
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/pricing"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[8px] border border-edge-strong bg-surface px-5 text-[13px] font-semibold text-ink transition hover:bg-surface-3"
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
    <header className="sticky top-0 z-40 border-b border-edge bg-surface">
      <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center gap-4 px-6 sm:px-8 lg:px-8">
        <Link href="/" className="shrink-0 rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25">
          <BrandMark title="Yaseir" subtitle="Print Manager" size="sm" showWordmark />
        </Link>
        <nav className="hidden min-w-0 flex-1 items-center gap-1 md:flex" aria-label="Landing page">
          <Anchor href="#product">Product</Anchor>
          <Anchor href="#how-it-works">How it works</Anchor>
          <Anchor href="#reliability">Reliability</Anchor>
          <Anchor href="#security">Security</Anchor>
          <Link href="/pricing" className="inline-flex h-10 items-center rounded-[8px] px-3 text-[13px] font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink">
            Pricing
          </Link>
        </nav>

        <ThemeToggle />

        <details className="relative md:hidden">
          <summary className="flex h-10 list-none cursor-pointer items-center justify-center rounded-[8px] border border-edge bg-surface px-3 text-[12px] font-semibold text-ink-2 transition hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
            Menu
          </summary>
          <div className="absolute right-0 top-12 z-50 w-56 rounded-[10px] border border-edge bg-surface p-2 shadow-lg">
            <div className="space-y-1">
              <Anchor href="#product">Product</Anchor>
              <Anchor href="#how-it-works">How it works</Anchor>
              <Anchor href="#reliability">Reliability</Anchor>
              <Anchor href="#security">Security</Anchor>
              <Link href="/pricing" className="flex h-10 items-center rounded-[8px] px-3 text-[13px] font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink">
                Pricing
              </Link>
              <Link href="/login" className="flex h-10 items-center rounded-[8px] px-3 text-[13px] font-semibold text-ink-2 transition hover:bg-surface-2 hover:text-ink sm:hidden">
                Sign in
              </Link>
            </div>
          </div>
        </details>

        <div className="ml-auto hidden items-center gap-2 md:flex">
          <Link href="/login" className="hidden h-10 items-center rounded-[8px] px-3.5 text-[13px] font-semibold text-ink-2 transition hover:bg-surface-2 hover:text-ink sm:inline-flex">
            Sign in
          </Link>
          <Link href="/signup" className="inline-flex h-10 items-center gap-2 rounded-[8px] bg-brand px-4 text-[13px] font-semibold text-white transition hover:bg-brand-hover">
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
    <footer className="border-t border-edge bg-surface">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-10 sm:px-8 lg:flex-row lg:items-start lg:justify-between lg:px-8">
        <div>
          <BrandMark title="Yaseir" subtitle="Print Manager" size="sm" showWordmark />
          <p className="mt-3 max-w-[440px] text-[13px] leading-relaxed text-ink-3">
            Automated Odoo printing for receipts, invoices, labels, and reports — delivered to the right printer across your operation.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] font-medium text-ink-2">
          <Link href="/pricing" className="transition hover:text-ink">Pricing</Link>
          <Link href="/login" className="transition hover:text-ink">Sign in</Link>
          <Link href="/signup" className="transition hover:text-ink">Create account</Link>
          <span className="text-ink-3">Odoo 19</span>
        </div>
      </div>
    </footer>
  );
}

function Anchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="inline-flex h-10 items-center rounded-[8px] px-3 text-[13px] font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink">
      {children}
    </a>
  );
}

function TrustCell({ title, text }: { title: string; text: string }) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <div className="text-[13px] font-semibold text-ink">{title}</div>
      <div className="mt-1 text-[12px] leading-relaxed text-ink-3">{text}</div>
    </div>
  );
}

function GatewayHeroVisual() {
  return (
    <div className="overflow-hidden rounded-[10px] border border-edge bg-surface">
      <div className="flex items-center justify-between border-b border-edge bg-surface-2 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <BrandMark title="Yaseir Gateway" subtitle="Print operations" size="sm" />
        </div>
        <span className="text-[12px] font-medium text-ink-3">Operational</span>
      </div>

      <div className="px-4 py-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Print path</div>
        <ol className="mt-3 divide-y divide-edge border-y border-edge">
          <RuntimeRow index="01" title="Odoo" meta="Business intent stays in ERP" />
          <RuntimeRow index="02" title="Gateway" meta="Durable queue and routing" />
          <RuntimeRow index="03" title="Windows Agent" meta="Local execution and status reports" />
          <RuntimeRow index="04" title="Printer" meta="Spooler, raw and USB output" />
        </ol>

        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Delivery guarantees</div>
          <ul className="mt-2 space-y-2">
            <HeroCheck text="No browser dialogs at the counter" />
            <HeroCheck text="Route jobs to the right branch printer" />
            <HeroCheck text="Know what happened to every job" />
          </ul>
        </div>
      </div>

      <div className="border-t border-edge bg-surface-2 px-4 py-2.5 text-[12px] text-ink-3">
        Queue · branch routing · local execution · delivery tracking
      </div>
    </div>
  );
}

function HeroCheck({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2 text-[13px] text-ink-2">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
      <span>{text}</span>
    </li>
  );
}

function RuntimeRow({ index, title, meta }: { index: string; title: string; meta: string }) {
  return (
    <li className="flex items-baseline gap-3 px-1 py-2.5">
      <span className="w-7 shrink-0 font-mono text-[12px] tabular-nums text-ink-3">{index}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-ink">{title}</span>
        <span className="block text-[12px] text-ink-3">{meta}</span>
      </span>
    </li>
  );
}

function SectionIntro({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return (
    <div className="max-w-[640px]">
      <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">{eyebrow}</p>
      <h2 className="mt-2.5 text-[26px] font-bold leading-[1.15] tracking-[-0.02em] text-ink sm:text-[30px]">{title}</h2>
      <p className="mt-3 max-w-[600px] text-[14px] leading-[1.7] text-ink-2">{text}</p>
    </div>
  );
}

function ProductCard({ title, text, items }: { title: string; text: string; items: string[] }) {
  return (
    <article className="bg-surface p-5 sm:p-6">
      <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{text}</p>
      <ul className="mt-4 space-y-2 border-t border-edge pt-4">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-[13px] text-ink-2">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function FlowRow({ number, title, text }: { number: string; title: string; text: string }) {
  return (
    <li className="flex gap-4 px-5 py-4">
      <span className="w-8 shrink-0 font-mono text-[12px] font-semibold tabular-nums text-ink-3">{number}</span>
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{text}</p>
      </div>
    </li>
  );
}

function ReliabilityCell({ title, text }: { title: string; text: string }) {
  return (
    <div className="bg-surface p-5">
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{text}</p>
    </div>
  );
}

function SecurityPanel({ title, items }: { title: string; items: string[] }) {
  return (
    <article className="bg-surface p-5 sm:p-6">
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      <ul className="mt-4 space-y-2.5 border-t border-edge pt-4">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-[13px] leading-relaxed text-ink-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
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
    <div className="mx-auto w-full max-w-[1200px] px-6 py-8 sm:px-8">
      <section className="rounded-[10px] border border-edge bg-surface p-6 sm:p-7">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Workspace</p>
            <h1 className="mt-2 text-[26px] font-bold tracking-[-0.02em] text-ink">Welcome back</h1>
            <p className="mt-1.5 text-[15px] text-ink-2">{tenantName}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/dashboard" className="inline-flex h-10 items-center gap-2 rounded-[8px] bg-brand px-4 text-[13px] font-semibold text-white hover:bg-brand-hover">
              Open console <ArrowRight className="h-4 w-4" />
            </Link>
            {canBilling && <Link href="/billing" className="inline-flex h-10 items-center gap-2 rounded-[8px] border border-edge-strong bg-surface px-4 text-[13px] font-semibold text-ink hover:bg-surface-2">Billing</Link>}
          </div>
        </div>

        <dl className="mt-6 grid gap-px overflow-hidden rounded-[10px] border border-edge bg-edge sm:grid-cols-3">
          <StatusItem label="Plan" value={hasPlan ? planName! : "No plan"} />
          <StatusItem label="Subscription" value={subscriptionStatus ? formatStatus(subscriptionStatus) : "Not configured"} />
          <StatusItem label="Role" value={role} />
        </dl>
        {periodEnd && <p className="mt-4 text-[13px] text-ink-3">Current period ends {periodEnd.toLocaleDateString()}.</p>}
      </section>

      <section className="mt-4 grid gap-px overflow-hidden rounded-[10px] border border-edge bg-edge md:grid-cols-3">
        <QuickLink href="/dashboard" title="Console" text="Agents, printers and jobs in one operational view." meta={hasPlan ? planName ?? "" : "Setup needed"} />
        <QuickLink href="/api-keys" title="Odoo integration" text="Credentials, activation state and connection health." meta="Integration" />
        {canTeam ? <QuickLink href="/team" title="Team" text="Members, roles and ownership transfer." meta="Admin" /> : <QuickLink href="/settings" title="Settings" text="Workspace identity and control center." meta="General" />}
      </section>

      <p className="mt-8 text-center text-[12px] text-ink-3">
        Odoo → Gateway → Windows Agent → Printer
      </p>
    </div>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">{label}</dt>
      <dd className="mt-1.5 text-[14px] font-semibold text-ink">{value}</dd>
    </div>
  );
}

function QuickLink({ href, title, text, meta }: { href: string; title: string; text: string; meta: string }) {
  return (
    <Link href={href} className="group bg-surface p-5 transition hover:bg-surface-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        <span className="text-[12px] text-ink-3">{meta}</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{text}</p>
      <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-brand">
        Open <ArrowUpRight className="h-3.5 w-3.5" />
      </span>
    </Link>
  );
}

function formatStatus(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
