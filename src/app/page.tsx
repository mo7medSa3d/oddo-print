import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../db";
import { plans, tenantSubscriptions, tenants } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  ArrowRight,
  Check,
  CreditCard,
  KeyRound,
  Network,
  Printer,
  Settings,
  ShieldCheck,
  Users,
  Zap,
  Layers,
  Cpu,
  ArrowUpRight,
} from "lucide-react";
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
    <div className="flex flex-col">
      {/* Hero — premium, restrained */}
      <section className="relative overflow-hidden border-b border-edge bg-surface">
        <div className="absolute inset-0 bg-gradient-to-br from-brand-50/60 via-transparent to-transparent pointer-events-none" />
        <div className="relative mx-auto w-full max-w-[1280px] px-6 py-20 sm:py-28 lg:py-32">
          <div className="max-w-[720px]">
            <div className="inline-flex items-center gap-2 rounded-full border border-edge-accent bg-brand-subtle px-3 py-1 text-[11px] font-semibold tracking-wide text-brand">
              <span className="h-1.5 w-1.5 rounded-full bg-brand animate-pulse" />
              Odoo 19 • Production print operations
            </div>
            <h1 className="mt-6 text-[40px] font-bold tracking-[-0.03em] leading-[0.95] text-ink sm:text-[52px] lg:text-[56px]">
              Print from Odoo
              <span className="block text-ink-3 font-[600]">without the browser dialog.</span>
            </h1>
            <p className="mt-6 max-w-[560px] text-[17px] leading-relaxed text-ink-2">
              Yasser routes Odoo reports, POS receipts, and automated print jobs to physical printers
              through a central Gateway and Windows Agent — durable, audited, production-grade.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/signup"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-brand px-6 text-[14px] font-semibold text-white shadow-[0_1px_2px_rgba(37,99,235,0.18)] hover:bg-brand-hover transition"
              >
                Start trial <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex h-11 items-center justify-center rounded-[10px] border border-edge bg-surface px-6 text-[14px] font-semibold text-ink hover:bg-surface-2 transition"
              >
                Sign in
              </Link>
              <Link
                href="/pricing"
                className="inline-flex h-11 items-center justify-center rounded-[10px] border border-edge bg-surface px-6 text-[14px] font-semibold text-ink hover:bg-surface-2 transition"
              >
                View plans
              </Link>
            </div>
            <div className="mt-8 flex items-center gap-6 text-[12px] text-ink-3">
              <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-ok" /> SOC2-ready audit</span>
              <span className="inline-flex items-center gap-1.5"><Zap className="h-4 w-4 text-brand" /> Silent printing</span>
              <span className="inline-flex items-center gap-1.5"><Layers className="h-4 w-4 text-ink-3" /> Multi-tenant</span>
            </div>
          </div>

          {/* Abstract operational preview — not a fake chart */}
          <div className="mt-16 grid gap-4 sm:grid-cols-3 max-w-[960px]">
            <div className="rounded-[14px] border border-edge bg-surface p-5 shadow-card">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Live console</div>
              <div className="mt-3 flex items-center gap-2 text-[13px] text-ink"><span className="h-2 w-2 rounded-full bg-ink-4" /> Edge agents</div>
              <div className="mt-2 text-[12px] text-ink-3">Heartbeat • Agent fleet</div>
            </div>
            <div className="rounded-[14px] border border-edge bg-surface p-5 shadow-card">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Printer fleet</div>
              <div className="mt-3 text-[15px] font-semibold tracking-tight text-ink">Managed fleet</div>
              <div className="mt-1 text-[12px] text-ink-3">ESC/POS • ZPL • PDF spooler</div>
            </div>
            <div className="rounded-[14px] border border-edge-accent bg-brand-subtle p-5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">Delivery</div>
              <div className="mt-3 text-[13px] font-medium text-ink">Durable jobs, claim fencing, idempotency</div>
              <div className="mt-2 text-[12px] text-ink-3">No duplicate printing</div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-edge bg-app">
        <div className="mx-auto w-full max-w-[1280px] px-6 py-12 sm:py-16">
          <div className="max-w-2xl">
            <h2 className="text-[22px] font-bold tracking-tight text-ink">Operational clarity, not developer demo</h2>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-3">Built for production — every state is explicit, every failure is actionable, no fake metrics.</p>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <FeatureCard icon={<Printer className="h-5 w-5" />} title="Silent printing" description="Reports and POS output go straight to configured printer — no browser dialog, no manual step." />
            <FeatureCard icon={<ShieldCheck className="h-5 w-5" />} title="Reliable delivery" description="Durable queue, retries, idempotency keys, claim fencing protect the print path end-to-end." />
            <FeatureCard icon={<Network className="h-5 w-5" />} title="Automated routing" description="Print Policies trigger PDF or raw label printing from business events — sales, stock, POS." />
          </div>
        </div>
      </section>

      <section className="bg-surface">
        <div className="mx-auto w-full max-w-[1280px] px-6 py-12 sm:py-20">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-xl">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Architecture</div>
              <h2 className="mt-3 text-[24px] font-bold tracking-tight text-ink">Odoo → Gateway → Agent → Printer</h2>
              <p className="mt-3 text-[14px] leading-relaxed text-ink-3">Odoo keeps business context. Gateway handles runtime delivery, entitlements, and audit. Windows Agent talks to local hardware.</p>
            </div>
            <Link href="/pricing" className="inline-flex items-center gap-2 text-[13px] font-semibold text-brand hover:underline">See plans <ArrowRight className="h-4 w-4" /></Link>
          </div>
          <ol className="mt-10 grid gap-3 md:grid-cols-4">
            <Step step="01" title="Odoo" text="Create print intent via API or POS. Business branch & destination stay in Odoo." />
            <Step step="02" title="Gateway" text="Validate tenant, entitlement, idempotency — then queue durable job." />
            <Step step="03" title="Agent" text="Claim via WS, deliver to local site, report outcome with fencing." />
            <Step step="04" title="Printer" text="Physical print + outcome: success, failed (not printed), unknown (verify)." />
          </ol>
        </div>
      </section>
    </div>
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
            <Link href="/dashboard" className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-brand px-5 text-[13px] font-semibold text-white shadow-sm hover:bg-brand-hover">
              Open console <ArrowRight className="h-4 w-4" />
            </Link>
            {canBilling && <Link href="/billing" className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-edge bg-surface px-5 text-[13px] font-semibold text-ink hover:bg-surface-2">Billing</Link>}
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
        <QuickLink href="/dashboard" icon={<Cpu className="h-5 w-5" />} title="Console" text="Manage agents, printers, jobs — operational dashboard." badge={`${hasPlan ? planName : "Setup needed"}`} />
        <QuickLink href="/api-keys" icon={<KeyRound className="h-5 w-5" />} title="API Keys" text="Odoo credentials, activation state, connection health — separated." badge="Integration" />
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

function FeatureCard({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="rounded-[14px] border border-edge bg-surface p-5 shadow-card">
      <div className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-edge-accent bg-brand-subtle text-brand">{icon}</div>
      <h2 className="mt-4 text-[14px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">{description}</p>
    </div>
  );
}

function Step({ step, title, text }: { step: string; title: string; text: string }) {
  return (
    <li className="rounded-[12px] border border-edge bg-surface-2 p-4">
      <span className="font-mono text-[11px] font-bold tracking-wide text-brand">{step}</span>
      <h3 className="mt-2 text-[14px] font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">{text}</p>
    </li>
  );
}

function formatStatus(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
