import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getManagerCookieName, validateManagerClaims, verifyManagerToken } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import { BillingActions } from "../../components/BillingActions";
import { CreditCard, Calendar, AlertTriangle, CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ checkout?: string | string[]; plan?: string | string[] }>;

type SubscriptionRow = typeof tenantSubscriptions.$inferSelect;

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const INTERVAL_WORD: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

/**
 * The status line reads the subscription state machine and speaks in the
 * operator's vocabulary: a trial ends, an active plan renews (or ends when
 * cancellation is scheduled), past-due asks for payment. Never "Renews" on a
 * trial, never a bare adjective without the action it implies.
 */
function planStatus(sub: SubscriptionRow): { chipClass: string; chipLabel: string; line: string } {
  const end = sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : null;
  switch (sub.status) {
    case "trialing": {
      // A Stripe-native trial converts through the portal (payment method on
      // file); a platform trial converts by subscribing to the same plan.
      const viaStripe = !!sub.stripeSubscriptionId;
      return {
        chipClass: "border-ok-edge bg-ok-bg text-ok",
        chipLabel: "Trial",
        line: end
          ? viaStripe
            ? `Your trial ends ${end}. Open the Customer Portal to add a payment method and keep this plan.`
            : `Your trial ends ${end}. Subscribe below to keep this plan.`
          : "Your trial is active. Subscribe below to keep this plan.",
      };
    }
    case "active":
      return {
        chipClass: "border-ok-edge bg-ok-bg text-ok",
        chipLabel: "Active",
        line: sub.cancelAtPeriodEnd && end ? `Your plan ends ${end}.` : end ? `Renews ${end}.` : "Active subscription.",
      };
    case "past_due":
      return {
        chipClass: "border-bad-edge bg-bad-bg text-bad",
        chipLabel: "Payment needed",
        line: "A payment failed. Open the Customer Portal to update your payment method.",
      };
    case "paused":
      return {
        chipClass: "border-warn-edge bg-warn-bg text-warn",
        chipLabel: "Paused",
        line: "Printing is paused. Resume from the Customer Portal to restore service.",
      };
    default:
      return {
        chipClass: "border-edge bg-surface-2 text-ink-3",
        chipLabel: "Canceled",
        line: "Your subscription is canceled. Choose a plan below to restart it.",
      };
  }
}

function formatEntitlementKey(value: string) {
  return value.replace(/^max_/, "").replace(/_/g, " ");
}

function formatEntitlementValue(value: unknown) {
  if (typeof value === "boolean") return value ? "Included" : "—";
  if (typeof value === "number") return value.toLocaleString();
  if (value === "unlimited") return "Unlimited";
  return String(value);
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
  const plan = sub
    ? await db.query.plans.findFirst({
        where: eq(plans.id, sub.planId),
        columns: { name: true, currency: true, interval: true, entitlements: true },
      })
    : null;

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
    ? Object.entries(plan.entitlements).map(([key, value]) => ({ label: formatEntitlementKey(key), value: formatEntitlementValue(value) }))
    : [];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          <CreditCard className="h-3.5 w-3.5" /> Workspace billing
        </div>
        <h1 className="mt-4 text-[26px] font-bold tracking-[-0.02em] text-ink">Billing</h1>
        <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-3">Your plan, its limits, and your subscription.</p>
      </header>

      {checkoutState === "success" && (
        <Notice tone="success" title="Checkout completed">Payment submitted. Your subscription may take a moment to appear here.</Notice>
      )}
      {checkoutState === "cancelled" && (
        <Notice tone="neutral" title="Checkout cancelled">Nothing was changed. Pick a plan whenever you are ready.</Notice>
      )}
      {sub && sub.checkoutStatus === "creating" && checkoutState !== "success" && checkoutState !== "cancelled" && (
        <Notice tone="info" title="Checkout is starting">We are preparing your checkout session. This page updates when it completes.</Notice>
      )}
      {sub && sub.checkoutStatus === "open" && checkoutState !== "success" && checkoutState !== "cancelled" && (
        <Notice tone="info" title="Checkout is open">Complete the payment in the Stripe window, then you will return here.</Notice>
      )}

      {/* My plan — the one element this page exists for */}
      <section className="billing-premium p-7">
        {status ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-[28px] font-bold tracking-tight text-ink">{plan?.name ?? "No plan"}</h2>
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${status.chipClass}`}>
                {status.chipLabel}
              </span>
            </div>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{status.line}</p>
            {hasStripeSubscription && plan?.interval && sub?.status !== "trialing" && !sub?.cancelAtPeriodEnd && (
              <p className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-ink-3">
                <Calendar className="h-3.5 w-3.5" /> Billed {INTERVAL_WORD[plan.interval] ?? plan.interval}
              </p>
            )}
          </>
        ) : (
          <>
            <h2 className="text-[28px] font-bold tracking-tight text-ink">No plan yet</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">Choose a plan below to start printing.</p>
          </>
        )}

        {entitlements.length > 0 && (
          <div className="mt-6">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Included in your plan</div>
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {entitlements.slice(0, 8).map((e) => (
                <div key={e.label} className="rounded-[10px] border border-edge bg-surface px-3.5 py-3">
                  <div className="text-[11px] font-medium text-ink-3 capitalize">{e.label}</div>
                  <div className="mt-1 text-[14px] font-semibold tabular-nums text-ink">{e.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {sub?.status === "past_due" && (
          <WarnLine text="Printing is blocked until the failed payment is resolved. The Customer Portal can update your card." />
        )}
        {sub?.cancelAtPeriodEnd && sub.status === "active" && sub.currentPeriodEnd && (
          <WarnLine text={`Cancellation is scheduled for ${formatDate(sub.currentPeriodEnd)}. Resume below to keep your plan.`} />
        )}

        <div className="mt-7 border-t border-edge pt-6">
          <BillingActions
            hasSubscription={hasActivePlan && hasStripeSubscription}
            cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd}
            currentPlanId={hasActivePlan ? (sub?.planId ?? null) : null}
            plans={availablePlans}
            selectedPlanId={selectedPlanId}
          />
        </div>

        {sub?.stripeCustomerId && (
          <p className="mt-5 truncate font-mono text-[11px] text-ink-4" title={sub.stripeCustomerId}>
            Stripe customer {sub.stripeCustomerId}
          </p>
        )}
      </section>
    </div>
  );
}

function WarnLine({ text }: { text: string }) {
  return (
    <div className="mt-5 flex items-start gap-2.5 rounded-[10px] border border-warn-edge bg-warn-bg px-4 py-3 text-[13px] text-warn">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function Notice({ tone, title, children }: { tone: "success" | "info" | "neutral"; title: string; children: React.ReactNode }) {
  const cls = {
    success: "border-ok-edge bg-ok-bg text-ok",
    info: "border-info-edge bg-info-bg text-info",
    neutral: "border-edge bg-surface-2 text-ink-2",
  } as const;
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <div className={`mb-6 flex items-start gap-2.5 rounded-[12px] border px-4 py-3 text-[13px] ${cls[tone]}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div><div className="font-semibold">{title}</div><div className="mt-0.5 leading-relaxed opacity-90">{children}</div></div>
    </div>
  );
}
