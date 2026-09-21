import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getManagerCookieName, validateManagerClaims, verifyManagerToken } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import { BillingActions } from "../../components/BillingActions";
import { CreditCard, ShieldCheck, Calendar, Zap, ArrowRight, AlertTriangle, CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ checkout?: string | string[] }>;

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
  const isScheduledForCancellation = hasActivePlan && !!sub?.cancelAtPeriodEnd;
  const isCheckoutPending = sub?.checkoutStatus === "creating" || sub?.checkoutStatus === "open";

  const entitlements = plan?.entitlements ? Object.entries(plan.entitlements).map(([k, v]) => ({ label: formatEntitlementKey(k), value: formatEntitlementValue(v) })) : [];

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            <CreditCard className="h-3.5 w-3.5" /> Workspace billing
          </div>
          <h1 className="mt-4 text-[26px] font-bold tracking-[-0.02em] text-ink">Billing & usage</h1>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-3">
            Plan, entitlements, and Stripe subscription — all enforced server-side.
          </p>
        </div>
        <Link href="/pricing" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand hover:underline">
          View all plans <ArrowRight className="h-4 w-4" />
        </Link>
      </header>

      {checkoutState === "success" && (
        <Notice tone="success" title="Checkout completed">Payment submitted. Stripe sync can take a moment.</Notice>
      )}
      {checkoutState === "cancelled" && (
        <Notice tone="neutral" title="Checkout cancelled">No change applied. Choose a plan when ready.</Notice>
      )}
      {isCheckoutPending && checkoutState !== "success" && (
        <Notice tone="info" title="Checkout processing">Billing operation in progress. Refresh after payment flow finishes.</Notice>
      )}

      {/* Premium billing card */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="billing-premium p-7">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-edge-accent bg-brand-subtle px-3 py-1 text-[11px] font-semibold tracking-wide text-brand">
                  <ShieldCheck className="h-3.5 w-3.5" /> PLAN
                </div>
                <div className="mt-4 flex items-baseline gap-3">
                  <div className="text-[28px] font-bold tracking-tight text-ink">{plan?.name ?? "No plan"}</div>
                  {sub && <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusToneClass(sub.status)}`}>{formatStatus(sub.status)}</span>}
                </div>
                <div className="mt-2 flex items-center gap-4 text-[13px] text-ink-3">
                  <span className="inline-flex items-center gap-1.5"><Calendar className="h-4 w-4" /> {sub?.currentPeriodEnd ? `Renews ${sub.currentPeriodEnd.toLocaleDateString()}` : "No renewal"}</span>
                  {plan?.interval && <span className="inline-flex items-center gap-1.5"><Zap className="h-4 w-4" /> Billed {plan.interval}</span>}
                </div>
              </div>
              <div className="hidden sm:block text-right">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Status</div>
                <div className="mt-2 text-[14px] font-semibold text-ink">{hasActivePlan ? "Active workspace" : "No active subscription"}</div>
                <div className="mt-1 text-[12px] text-ink-3">{hasStripeSubscription ? "Stripe linked" : "Trial or unlinked"}</div>
              </div>
            </div>

            {entitlements.length > 0 && (
              <div className="mt-7">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Entitlements</div>
                <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {entitlements.slice(0, 6).map((e) => (
                    <div key={e.label} className="rounded-[10px] border border-edge bg-surface-2 px-3.5 py-3">
                      <div className="text-[11px] font-medium text-ink-3 capitalize">{e.label}</div>
                      <div className="mt-1 text-[14px] font-semibold tabular-nums text-ink">{e.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isScheduledForCancellation && sub?.currentPeriodEnd && (
              <div className="mt-6 flex items-start gap-2.5 rounded-[10px] border border-warn-edge bg-warn-bg px-4 py-3 text-[13px] text-warn">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Scheduled to cancel on <strong>{sub.currentPeriodEnd.toLocaleDateString()}</strong>. Resume before then to keep service.</span>
              </div>
            )}
            {sub?.status === "past_due" && (
              <div className="mt-6 flex items-start gap-2.5 rounded-[10px] border border-bad-edge bg-bad-bg px-4 py-3 text-[13px] text-bad">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Payment past due — update payment method via Customer Portal.</span>
              </div>
            )}

            <div className="mt-8 border-t border-edge pt-6">
              {hasActivePlan ? (
                hasStripeSubscription ? (
                  <BillingActions
                      hasSubscription={true}
                      cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd}
                      currentPlanId={sub?.planId ?? null}
                      plans={availablePlans}
                      selectedPlanId={selectedPlanId}
                    />
                ) : (
                  <div className="rounded-[10px] border border-edge bg-surface-2 px-4 py-3 text-[13px] text-ink-2">Active plan without Stripe link. Billing management will appear when paid subscription connects.</div>
                )
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Link href="/pricing" className="inline-flex h-10 items-center justify-center rounded-[10px] bg-brand px-5 text-[13px] font-semibold text-white shadow-sm hover:bg-brand-hover">Choose a plan</Link>
                  <span className="text-[12px] text-ink-3">Plans enforced by Gateway. No fake values.</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-6">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Billing summary</div>
            <div className="mt-4 space-y-3">
              <div className="flex justify-between text-[13px]"><span className="text-ink-3">Plan</span><span className="font-semibold text-ink">{plan?.name ?? "—"}</span></div>
              <div className="flex justify-between text-[13px]"><span className="text-ink-3">Status</span><span className="font-semibold text-ink">{sub ? formatStatus(sub.status) : "—"}</span></div>
              <div className="flex justify-between text-[13px]"><span className="text-ink-3">Period end</span><span className="font-medium text-ink">{sub?.currentPeriodEnd ? sub.currentPeriodEnd.toLocaleDateString() : "—"}</span></div>
              <div className="flex justify-between text-[13px]"><span className="text-ink-3">Stripe customer</span><span className="font-mono text-[11px] text-ink-2">{sub?.stripeCustomerId ? `${sub.stripeCustomerId.slice(0, 12)}…` : "—"}</span></div>
            </div>
            <div className="mt-6 rounded-[10px] bg-surface-2 border border-edge p-3 text-[12px] leading-relaxed text-ink-3">
              <div className="flex items-center gap-2 font-semibold text-ink"><ShieldCheck className="h-4 w-4 text-ok" /> Secure billing</div>
              <p className="mt-1">Stripe handles payments. Gateway enforces entitlements server-side — no client bypass.</p>
            </div>
          </div>

          <div className="card p-6">
            <div className="text-[13px] font-semibold text-ink">Need help?</div>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3">Billing issues are audited. Past-due or paused states are shown explicitly — no hidden statuses.</p>
            <Link href="/settings" className="mt-4 inline-flex text-[12px] font-semibold text-brand hover:underline">Workspace settings →</Link>
          </div>
        </div>
      </div>
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

function statusToneClass(v: string | undefined) {
  if (v === "active" || v === "trialing") return "border-ok-edge bg-ok-bg text-ok";
  if (v === "paused") return "border-warn-edge bg-warn-bg text-warn";
  if (v === "past_due" || v === "cancelled") return "border-bad-edge bg-bad-bg text-bad";
  return "border-edge bg-surface-2 text-ink-3";
}

function formatStatus(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
