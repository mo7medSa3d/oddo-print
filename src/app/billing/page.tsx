import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getManagerCookieName, validateManagerClaims, verifyManagerToken } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import { BillingActions } from "../../components/BillingActions";
import { ArrowRight, AlertTriangle, Calendar, CheckCircle2, CreditCard } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "../../components/ui";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ checkout?: string | string[]; plan?: string | string[] }>;
type SubscriptionRow = typeof tenantSubscriptions.$inferSelect;

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatStatus(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function entitlementLabel(value: string) {
  return value.replace(/^max_/, "").replace(/_/g, " ");
}

function entitlementValue(value: unknown) {
  if (value === "unlimited") return "Unlimited";
  if (typeof value === "boolean") return value ? "Included" : "—";
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

function planStatus(sub: SubscriptionRow) {
  const end = sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : null;
  if (sub.status === "trialing") {
    return {
      tone: "ok" as const,
      label: "Trial",
      message: end
        ? sub.stripeSubscriptionId
          ? `Your trial ends ${end}. Use the Customer Portal to add a payment method and keep this plan.`
          : `Your trial ends ${end}. Subscribe below to keep this plan.`
        : "Your trial is active. Subscribe below to keep this plan.",
    };
  }
  if (sub.status === "active") {
    return {
      tone: "ok" as const,
      label: "Active",
      message: sub.cancelAtPeriodEnd && end ? `Cancellation is scheduled for ${end}.` : end ? `Renews ${end}.` : "Active subscription.",
    };
  }
  if (sub.status === "past_due") {
    return { tone: "bad" as const, label: "Payment needed", message: "A payment failed. Open the Customer Portal to update your payment method." };
  }
  if (sub.status === "paused") {
    return { tone: "warn" as const, label: "Paused", message: "Printing is paused. Resume from the Customer Portal to restore service." };
  }
  return { tone: "neutral" as const, label: "Canceled", message: "Your subscription is canceled. Choose a plan to restart it." };
}

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) redirect("/login");
  if (!hasManagerPermission(claims, "billing.read")) redirect("/dashboard");

  const params = await searchParams;
  const checkoutState = typeof params.checkout === "string" ? params.checkout : undefined;
  const selectedPlanId = typeof params.plan === "string" ? params.plan : undefined;

  const sub = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, claims.tenantId) });
  const plan = sub ? await db.query.plans.findFirst({
    where: eq(plans.id, sub.planId),
    columns: { name: true, currency: true, interval: true, entitlements: true },
  }) : null;

  const availablePlans = await db
    .select({
      id: plans.id,
      name: plans.name,
      entitlements: plans.entitlements,
      currency: plans.currency,
      interval: plans.interval,
      displayOrder: plans.displayOrder,
    })
    .from(plans)
    .where(and(eq(plans.isActive, true), eq(plans.isPublic, true)))
    .orderBy(asc(plans.displayOrder), asc(plans.name));

  const activeStatuses = new Set(["trialing", "active", "past_due", "paused"]);
  const hasActivePlan = !!sub && activeStatuses.has(sub.status);
  const hasStripeSubscription = !!sub?.stripeCustomerId && !!sub?.stripeSubscriptionId;
  const status = sub && hasActivePlan ? planStatus(sub) : null;
  const entitlements = plan?.entitlements
    ? Object.entries(plan.entitlements).map(([key, value]) => ({ label: entitlementLabel(key), value: entitlementValue(value) }))
    : [];

  return (
    <div className="mx-auto w-full max-w-[1380px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <header className="flex flex-col gap-5 border-b border-edge/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">
            <CreditCard className="h-3.5 w-3.5 text-brand" /> Workspace billing
          </div>
          <h1 className="mt-2.5 text-[30px] font-bold leading-tight tracking-[-0.035em] text-ink">Billing & subscription</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">One place to understand the current plan, its limits, and what happens next.</p>
        </div>
        <Link href="/pricing" className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[10px] border border-edge bg-surface px-4 text-[13px] font-semibold text-ink-2 shadow-xs transition hover:border-edge-strong hover:bg-surface-2 hover:text-ink">
          View plans <ArrowRight className="h-4 w-4" />
        </Link>
      </header>

      <div className="mt-6 space-y-4">
        {checkoutState === "success" && <Notice tone="success" title="Checkout completed">Payment submitted. Stripe sync can take a moment.</Notice>}
        {checkoutState === "cancelled" && <Notice tone="neutral" title="Checkout cancelled">No subscription change was applied.</Notice>}
        {sub && (sub.checkoutStatus === "creating" || sub.checkoutStatus === "open") && checkoutState !== "success" && checkoutState !== "cancelled" && (
          <Notice tone="info" title="Checkout in progress">A billing operation is already running. The subscription will update when Stripe confirms it.</Notice>
        )}
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,.6fr)]">
        <section className="overflow-hidden rounded-[16px] border border-edge-strong bg-surface shadow-card">
          <div className="border-b border-edge bg-surface-2/55 px-6 py-5">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Current subscription</div>
              {status && <StatusBadge tone={status.tone} label={status.label} />}
            </div>
            <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-[26px] font-semibold tracking-[-0.03em] text-ink">{plan?.name ?? "No plan"}</h2>
                <p className="mt-1 text-[13px] text-ink-3">{status?.message ?? "Choose a plan to start printing."}</p>
              </div>
              <div className="flex items-center gap-2 text-[12px] text-ink-3">
                <Calendar className="h-4 w-4" />
                {sub?.currentPeriodEnd ? (sub.cancelAtPeriodEnd ? `Ends ${formatDate(sub.currentPeriodEnd)}` : `Next period ${formatDate(sub.currentPeriodEnd)}`) : "No renewal date"}
              </div>
            </div>
          </div>

          {entitlements.length > 0 && (
            <div className="px-6 py-6">
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Plan entitlements</div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {entitlements.slice(0, 8).map((e) => (
                  <div key={e.label} className="rounded-[10px] border border-edge bg-surface-2 px-3.5 py-3">
                    <div className="text-[11px] capitalize text-ink-3">{e.label}</div>
                    <div className="mt-1 text-[14px] font-semibold tabular-nums text-ink">{e.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(sub?.status === "past_due" || (sub?.cancelAtPeriodEnd && sub.status === "active" && sub.currentPeriodEnd)) && (
            <div className="border-t border-edge px-6 py-5">
              {sub?.status === "past_due" && <WarnLine text="Printing is blocked until the failed payment is resolved. The Customer Portal can update your payment method." />}
              {sub?.cancelAtPeriodEnd && sub.status === "active" && sub.currentPeriodEnd && <WarnLine text={`Cancellation is scheduled for ${formatDate(sub.currentPeriodEnd)}. Resume below to keep the plan.`} />}
            </div>
          )}

          <div className="border-t border-edge bg-surface-2/35 px-6 py-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Subscription actions</div>
            <div className="mt-3">
              <BillingActions
                hasSubscription={hasActivePlan && hasStripeSubscription}
                cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd}
                currentPlanId={hasActivePlan ? (sub?.planId ?? null) : null}
                plans={availablePlans}
                selectedPlanId={selectedPlanId}
              />
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-[14px] border border-edge bg-surface p-5 shadow-card">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Billing state</div>
            <div className="mt-4 space-y-3">
              <Row label="Subscription" value={sub ? formatStatus(sub.status) : "Not configured"} />
              <Row label="Stripe" value={hasStripeSubscription ? "Connected" : sub?.stripeCustomerId ? "Customer linked" : "Not linked"} />
              {plan?.interval && <Row label="Interval" value={plan.interval} />}
            </div>
            {sub?.stripeCustomerId && <p className="mt-4 break-all border-t border-edge pt-4 font-mono text-[10.5px] text-ink-4">Customer {sub.stripeCustomerId}</p>}
          </section>

          <section className="rounded-[14px] border border-edge bg-surface-2 p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
              <div>
                <div className="text-[13px] font-semibold text-ink">Stripe is the billing source of truth</div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">Checkout, subscription status, and payment-method changes are confirmed through Stripe events.</p>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-4"><span className="text-[12px] text-ink-3">{label}</span><span className="text-right text-[12.5px] font-semibold text-ink">{value}</span></div>;
}

function WarnLine({ text }: { text: string }) {
  return <div className="flex items-start gap-2.5 rounded-[10px] border border-warn-edge bg-warn-bg px-3.5 py-3 text-[12.5px] text-warn"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{text}</span></div>;
}

function Notice({ tone, title, children }: { tone: "success" | "info" | "neutral"; title: string; children: React.ReactNode }) {
  const classes = tone === "success"
    ? "border-ok-edge bg-ok-bg text-ok"
    : tone === "info"
      ? "border-info-edge bg-info-bg text-info"
      : "border-edge bg-surface-2 text-ink-2";
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return <div className={`flex items-start gap-3 rounded-[12px] border px-4 py-3.5 text-[13px] ${classes}`}><Icon className="mt-0.5 h-4 w-4 shrink-0" /><div><div className="font-semibold">{title}</div><div className="mt-0.5 leading-relaxed opacity-90">{children}</div></div></div>;
}
