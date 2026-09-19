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
      <section className="border-b border-edge bg-surface">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-16 sm:px-6 md:py-20">
          <div className="max-w-3xl">
            <p className="label-caps">Odoo 19 · Cloud print operations</p>
            <h1 className="mt-4 text-4xl font-extrabold tracking-tight text-ink sm:text-5xl">
              Print from Odoo without the browser dialog.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink-2 sm:text-lg">
              Yasser routes Odoo reports, receipts and automated print jobs to
              physical printers through a central Gateway and Windows Agent.
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/signup"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-5 py-3 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-95 focusable"
              >
                Start a trial <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link
                href="/pricing"
                className="inline-flex items-center justify-center rounded-lg border border-edge bg-surface px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 focusable"
              >
                View plans
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-edge bg-app">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-10 sm:px-6">
          <div className="grid gap-4 md:grid-cols-3">
            <FeatureCard
              icon={<Printer className="h-5 w-5" />}
              title="Silent printing"
              description="Reports and POS output go straight to the configured printer."
            />
            <FeatureCard
              icon={<ShieldCheck className="h-5 w-5" />}
              title="Reliable delivery"
              description="Durable jobs, retries, idempotency and claim fencing protect the print path."
            />
            <FeatureCard
              icon={<Network className="h-5 w-5" />}
              title="Automated routing"
              description="Odoo Print Policies can trigger PDF or raw label printing from business events."
            />
          </div>
        </div>
      </section>

      <section className="bg-surface">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-12 sm:px-6 md:py-16">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-xl">
              <p className="label-caps">How it works</p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink">
                Odoo → Gateway → Agent → Printer
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-ink-3">
                Odoo keeps the business context. The Gateway handles runtime
                delivery, while the Windows Agent handles the local printer.
              </p>
            </div>
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 text-sm font-semibold text-brand hover:underline"
            >
              See plans <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>

          <ol className="mt-8 grid gap-3 md:grid-cols-4">
            <Step step="01" title="Odoo" text="Create the print intent." />
            <Step step="02" title="Gateway" text="Validate and queue the job." />
            <Step step="03" title="Agent" text="Deliver it to the local site." />
            <Step step="04" title="Printer" text="Print and report the outcome." />
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
    <div className="mx-auto w-full max-w-[1200px] px-4 py-8 sm:px-6">
      <section className="card brand-hairline p-6 sm:p-8">
        <p className="label-caps">Workspace</p>
        <div className="mt-2 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-ink">
              Welcome back
            </h1>
            <p className="mt-2 text-base text-ink-2">{tenantName}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white focusable"
            >
              Open console <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            {canBilling && (
              <Link
                href="/billing"
                className="inline-flex items-center gap-2 rounded-lg border border-edge bg-surface px-4 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2 focusable"
              >
                Billing
              </Link>
            )}
          </div>
        </div>

        <div className="mt-7 grid gap-3 sm:grid-cols-3">
          <StatusItem label="Plan" value={hasPlan ? planName! : "No plan"} />
          <StatusItem
            label="Subscription"
            value={subscriptionStatus ? formatStatus(subscriptionStatus) : "Not configured"}
          />
          <StatusItem label="Role" value={role} />
        </div>

        {periodEnd && (
          <p className="mt-4 text-xs text-ink-3">
            Current period ends {periodEnd.toLocaleDateString()}.
          </p>
        )}
      </section>

      <section className="mt-5 grid gap-4 md:grid-cols-3">
        <QuickLink href="/dashboard" icon={<Printer className="h-5 w-5" />} title="Console" text="Manage agents, printers and print jobs." />
        <QuickLink href="/api-keys" icon={<KeyRound className="h-5 w-5" />} title="API Keys" text="Manage Odoo installation credentials." />
        {canTeam ? (
          <QuickLink href="/team" icon={<Users className="h-5 w-5" />} title="Team" text="Manage workspace members and roles." />
        ) : (
          <QuickLink href="/settings" icon={<Settings className="h-5 w-5" />} title="Settings" text="Update the workspace identity." />
        )}
      </section>

      <p className="mt-8 text-center text-xs text-ink-3">
        Odoo → Gateway → Windows Agent → Printer
      </p>
    </div>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-2 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}

function QuickLink({
  href,
  icon,
  title,
  text,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <Link href={href} className="card card-interactive p-5 focusable">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-edge-accent bg-brand-subtle text-brand">
        {icon}
      </div>
      <h2 className="mt-4 text-sm font-semibold text-ink">{title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-3">{text}</p>
    </Link>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="card p-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-edge-accent bg-brand-subtle text-brand">
        {icon}
      </div>
      <h2 className="mt-4 text-sm font-semibold text-ink">{title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{description}</p>
    </div>
  );
}

function Step({
  step,
  title,
  text,
}: {
  step: string;
  title: string;
  text: string;
}) {
  return (
    <li className="rounded-lg border border-edge bg-surface-2 p-4">
      <span className="font-mono text-xs font-semibold text-brand">{step}</span>
      <h3 className="mt-2 text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">{text}</p>
    </li>
  );
}

function formatStatus(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
