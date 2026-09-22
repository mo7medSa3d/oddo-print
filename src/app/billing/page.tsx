import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getManagerCookieName, validateManagerClaims, verifyManagerToken } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import { BillingActions } from "../../components/BillingActions";
import { ArrowRight, AlertTriangle, CalendarDays, Check, CheckCircle2, CreditCard, Sparkles } from "lucide-react";
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
      tone: "brand" as const,
      label: "Trial",
      message: end
        ? sub.stripeSubscriptionId
          ? `Your trial ends ${end}. Add a payment method in Stripe to keep this plan.`
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

  const sub = await db.query.tenantSubscriptions.findFirst({
    where: eq(tenantSubscriptions.tenantId, claims.tenantId),
  });

  const currentPlan = sub
    ? await db.query.plans.findFirst({
        where: eq(plans.id, sub.planId),
        columns: { id: true, name: true, description: true, currency: true, interval: true, entitlements: true },
      })
    : null;

  const availablePlans = await db
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
    .where(and(eq(plans.isActive, true), eq(plans.isPublic, true)))
    .orderBy(asc(plans.displayOrder), asc(plans.name));

  const selectedPlan = selectedPlanId ? availablePlans.find((item) => item.id === selectedPlanId) ?? null : null;
  const activeStatuses = new Set(["trialing", "active", "past_due", "paused"]);
  const hasActivePlan = !!sub && activeStatuses.has(sub.status);
  const hasStripeSubscription = !!sub?.stripeCustomerId && !!sub?.stripeSubscriptionId;
  const status = sub && hasActivePlan ? planStatus(sub) : null;
  const entitlements = currentPlan?.entitlements
    ? Object.entries(currentPlan.entitlements)
        .filter(([, value]) => value !== false)
        .slice(0, 8)
        .map(([key, value]) => ({ label: entitlementLabel(key), value: entitlementValue(value) }))
    : [];

  const renewalLabel = sub?.currentPeriodEnd
    ? sub.cancelAtPeriodEnd
      ? `Ends ${formatDate(sub.currentPeriodEnd)}`
      : `Renews ${formatDate(sub.currentPeriodEnd)}`
    : "No renewal date";

  return (
    <div className="mx-auto w-full max-w-[1280px] px-5 py-8 sm:px-7 lg:px-8 lg:py-10">
      <header className="flex flex-col gap-5 border-b border-edge/80 pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">
            <CreditCard className="h-3.5 w-3.5 text-brand" /> Workspace billing
          </div>
          <h1 className="mt-2.5 text-[28px] font-bold leading-tight tracking-[-0.04em] text-ink">Billing</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">
            Your subscription, entitlements, and billing controls in one place.
          </p>
        </div>
        <Link
          href="/pricing"
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[10px] bg-brand px-4 text-[13px] font-semibold text-white shadow-sm transition hover:bg-brand-hover hover:shadow-md"
        >
          {hasActivePlan ? "Upgrade plan" : "View plans"}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </header>

      <div className="mt-6 space-y-4">
        {checkoutState === "success" && <Notice tone="success" title="Checkout completed">Payment submitted. Stripe sync can take a moment.</Notice>}
        {checkoutState === "cancelled" && <Notice tone="neutral" title="Checkout cancelled">No subscription change was applied.</Notice>}
        {sub && (sub.checkoutStatus === "creating" || sub.checkoutStatus === "open") && checkoutState !== "success" && checkoutState !== "cancelled" && (
          <Notice tone="info" title="Checkout in progress">A billing operation is already running. The subscription will update when Stripe confirms it.</Notice>
        )}
      </div>

      {selectedPlan && selectedPlan.id !== currentPlan?.id && (
        <div className="mt-6">
          <BillingActions
            hasSubscription={hasActivePlan && hasStripeSubscription}
            cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd}
            selectedPlan={selectedPlan}
          />
        </div>
      )}

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_310px]">
        <section className="billing-premium overflow-hidden">
          <div className="border-b border-edge/80 bg-surface px-6 py-6 sm:px-7 sm:py-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">
                <Sparkles className="h-3.5 w-3.5 text-brand" /> Current plan
              </div>
              {status && <StatusBadge tone={status.tone} label={status.label} />}
            </div>

            <div className="mt-5 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0">
                <h2 className="text-[32px] font-bold tracking-[-0.045em] text-ink sm:text-[38px]">
                  {currentPlan?.name ?? "No plan selected"}
                </h2>
                <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">
                  {currentPlan?.description || status?.message || "Choose a plan to activate printing for this workspace."}
                </p>
              </div>

              <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                <Link
                  href="/pricing"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-brand px-5 text-[13.5px] font-semibold text-white shadow-sm transition hover:bg-brand-hover hover:shadow-md"
                >
                  {hasActivePlan ? "Upgrade plan" : "Choose a plan"}
                  <ArrowRight className="h-4 w-4" />
                </Link>
                {hasStripeSubscription && (
                  <a
                    href="#billing-actions"
                    className="inline-flex h-11 items-center justify-center rounded-[10px] border border-edge bg-surface px-5 text-[13.5px] font-semibold text-ink-2 transition hover:border-edge-strong hover:bg-surface-2 hover:text-ink"
                  >
                    Manage billing
                  </a>
                )}
              </div>
            </div>
          </div>

          <div className="grid divide-y divide-edge border-b border-edge sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <InfoCell label="Status" value={status?.label ?? "Not configured"} />
            <InfoCell label="Billing cycle" value={currentPlan?.interval ?? "—"} />
            <InfoCell label="Renewal" value={renewalLabel} />
          </div>

          <div className="px-6 py-6 sm:px-7 sm:py-7">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Included capacity</div>
                <h3 className="mt-1.5 text-[18px] font-semibold tracking-[-0.02em] text-ink">What your plan includes</h3>
              </div>
              <Link href="/pricing" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-brand hover:text-brand-hover">
                Compare plans <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            {entitlements.length > 0 ? (
              <div className="mt-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                {entitlements.map((entry) => (
                  <div key={entry.label} className="rounded-[12px] border border-edge bg-surface-2 px-4 py-3.5">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok-bg text-ok">
                        <Check className="h-3 w-3" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-[11px] capitalize text-ink-3">{entry.label}</div>
                        <div className="mt-1 text-[14px] font-semibold tabular-nums text-ink">{entry.value}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-5 rounded-[12px] border border-dashed border-edge-strong bg-surface-2 px-4 py-6 text-[13px] text-ink-3">
                Plan capacity is managed by Platform Admin.
              </div>
            )}
          </div>

          {sub && (sub.status === "past_due" || (sub.cancelAtPeriodEnd && sub.status === "active" && sub.currentPeriodEnd)) && (
            <div className="border-t border-edge px-6 py-5 sm:px-7">
              {sub.status === "past_due" && <WarnLine text="Printing is blocked until the failed payment is resolved. Use the Customer Portal to update the payment method." />}
              {sub.cancelAtPeriodEnd && sub.status === "active" && sub.currentPeriodEnd && <WarnLine text={`Cancellation is scheduled for ${formatDate(sub.currentPeriodEnd)}. Resume below to keep the plan.`} />}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <section className="rounded-[14px] border border-edge bg-surface p-5 shadow-card">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Subscription details</div>
            <div className="mt-4 space-y-0">
              <DetailRow label="Plan" value={currentPlan?.name ?? "Not configured"} />
              <DetailRow label="Status" value={sub ? formatStatus(sub.status) : "Not configured"} />
              <DetailRow label="Currency" value={currentPlan?.currency?.toUpperCase() ?? "—"} />
              <DetailRow label="Interval" value={currentPlan?.interval ?? "—"} />
              <DetailRow label="Renewal" value={renewalLabel} />
            </div>
          </section>

          <section className="rounded-[14px] border border-edge bg-surface px-5 py-5 shadow-card" id="billing-actions">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Billing controls</div>
            <div className="mt-3">
              <BillingActions
                hasSubscription={hasActivePlan && hasStripeSubscription}
                cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd}
              />
            </div>
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

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-6 py-4 sm:px-7">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">{label}</div>
      <div className="mt-1.5 text-[13.5px] font-semibold text-ink">{value}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-edge-subtle py-3 last:border-b-0">
      <span className="text-[12px] text-ink-3">{label}</span>
      <span className="text-right text-[12.5px] font-semibold text-ink">{value}</span>
    </div>
  );
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
