import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import { BillingActions } from "../../components/BillingActions";
import { AlertTriangle, ArrowRight, CalendarDays, Check, CreditCard, Receipt } from "lucide-react";
import Link from "next/link";
import {
  Button,
  Callout,
  Card,
  CardHeader,
  PageContainer,
  PageHeader,
  Progress,
  StatusBadge,
  type Tone,
} from "../../components/ui";
import { getTenantPrintUsage } from "../../lib/entitlements";
import { logWarn } from "../../lib/log";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ checkout?: string | string[]; plan?: string | string[] }>;
type SubscriptionRow = typeof tenantSubscriptions.$inferSelect;

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function entitlementLabel(value: string) {
  if (value === "max_prints_per_period") return "Print jobs / period";
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
    return {
      tone: "warn" as const,
      label: "Payment attention",
      message: "Stripe is retrying the latest payment. Printing remains available while the subscription is past due; update your payment method to avoid service interruption.",
    };
  }
  if (sub.status === "unpaid") {
    return { tone: "bad" as const, label: "Payment required", message: "Stripe has marked the subscription unpaid. Printing is paused until the outstanding payment is resolved in the Customer Portal." };
  }
  if (sub.status === "paused") {
    return { tone: "warn" as const, label: "Paused", message: "Stripe has paused the subscription. Add a valid payment method and resume the existing subscription." };
  }
  if (sub.status === "incomplete") {
    return { tone: "warn" as const, label: "Payment required", message: "The initial Stripe payment is incomplete. Complete the existing checkout or resolve the payment action before printing can start." };
  }
  if (sub.status === "incomplete_expired") {
    return { tone: "bad" as const, label: "Checkout expired", message: "The initial Stripe subscription payment expired before activation. Choose a plan to start a new checkout." };
  }
  return { tone: "neutral" as const, label: "Canceled", message: "Your subscription is canceled. Choose a plan to restart it." };
}

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get("cust_session")?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );
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

  let printUsage: Awaited<ReturnType<typeof getTenantPrintUsage>> | null = null;
  let printUsageUnavailable = false;
  if (sub) {
    try {
      printUsage = await getTenantPrintUsage(db, claims.tenantId);
    } catch (error) {
      printUsageUnavailable = true;
      // Never pass a live Error: JSON.stringify(Error) → {} loses the message.
      logWarn("billing.print_usage_unavailable", { error: error instanceof Error ? error.message : String(error) });
    }
  }

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
  const activeStatuses = new Set(["trialing", "active", "past_due"]);
  const hasActivePlan = !!sub && activeStatuses.has(sub.status);
  const hasStripeSubscription = !!sub?.stripeCustomerId && !!sub.stripeSubscriptionId;
  const status = sub ? planStatus(sub) : null;
  const entitlements = currentPlan?.entitlements
    ? Object.entries(currentPlan.entitlements)
        .filter(([, value]) => value !== false)
        .slice(0, 8)
        .map(([key, value]) => ({ label: entitlementLabel(key), value: entitlementValue(value) }))
    : [];

  const renewalLabel = !sub
    ? "No renewal date"
    : sub.status === "cancelled"
      ? sub.currentPeriodEnd
        ? `Ended ${formatDate(sub.currentPeriodEnd)}`
        : "Ended"
      : sub.cancelAtPeriodEnd && sub.currentPeriodEnd
        ? `Ends ${formatDate(sub.currentPeriodEnd)}`
        : sub.currentPeriodEnd
          ? `Renews ${formatDate(sub.currentPeriodEnd)}`
          : "No renewal date";

  const usagePct =
    printUsage && printUsage.limit !== "unlimited"
      ? Math.min(100, Math.max(0, (printUsage.used / Math.max(1, printUsage.limit)) * 100))
      : 0;
  const usageTone: Tone = printUsage && printUsage.limit !== "unlimited"
    ? printUsage.remaining === 0
      ? "bad"
      : usagePct >= 85
        ? "warn"
        : "brand"
    : "brand";

  const attentionStatuses = ["unpaid", "paused", "incomplete"];

  return (
    <>
      <PageHeader
        eyebrow="Workspace billing"
        icon={<CreditCard className="h-4 w-4" />}
        title="Billing"
        description="Your plan, billing cycle and the capacity included with it."
        meta={status ? <StatusBadge tone={status.tone} label={status.label} /> : <StatusBadge tone="neutral" label="No plan" />}
        actions={
          <>
            {hasStripeSubscription && (
              <Button variant="ghost" size="sm" href="#billing-actions" icon={<Receipt className="h-4 w-4" />}>
                Manage billing
              </Button>
            )}
            <Button variant="primary" size="sm" href="/pricing" icon={<ArrowRight className="h-4 w-4" />}>
              {hasActivePlan ? "Upgrade plan" : "View plans"}
            </Button>
          </>
        }
      />

      <PageContainer>
        <div className="space-y-5">
          {checkoutState === "success" && (
            <Callout tone="ok" title="Checkout completed">
              Payment submitted. Stripe sync can take a moment before the plan updates here.
            </Callout>
          )}
          {checkoutState === "cancelled" && (
            <Callout tone="neutral" title="Checkout cancelled">
              No subscription change was applied.
            </Callout>
          )}
          {sub && (sub.checkoutStatus === "creating" || sub.checkoutStatus === "open") && checkoutState !== "success" && checkoutState !== "cancelled" && (
            <Callout tone="info" title="Checkout in progress">
              A billing operation is already running. The subscription will update when Stripe
              confirms it.
            </Callout>
          )}
          {printUsageUnavailable && (
            <Callout tone="warn" title="Print usage temporarily unavailable">
              Current usage could not be loaded. Billing and printing controls remain available;
              refresh this page to try again.
            </Callout>
          )}

          {selectedPlan && selectedPlan.id !== currentPlan?.id && (
            <BillingActions
              hasSubscription={hasActivePlan && hasStripeSubscription}
              cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd}
              subscriptionStatus={sub?.status}
              canOpenPortal={hasStripeSubscription}
              checkoutUrl={sub?.checkoutSessionUrl}
              selectedPlan={selectedPlan}
            />
          )}

          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(300px,320px)]">
            <div className="space-y-5">
              <section className="card overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5">
                  <div className="min-w-0">
                    <div className="label-caps">Current plan</div>
                    <h2 className="mt-2 text-3xl font-[660] tracking-[-0.035em] text-ink">
                      {currentPlan?.name ?? "No plan selected"}
                    </h2>
                    <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-ink-3">
                      {currentPlan?.description || status?.message || "Choose a plan to activate printing for this workspace."}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                    <Button variant="primary" href="/pricing" icon={<ArrowRight className="h-4 w-4" />}>
                      {hasActivePlan ? "Upgrade plan" : "Choose a plan"}
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 divide-y divide-edge-subtle border-y border-edge-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                  <div className="px-5 py-4">
                    <div className="label-caps">Status</div>
                    <div className="mt-1.5 text-sm font-[600] text-ink">
                      {status ? status.label : "Not configured"}
                    </div>
                  </div>
                  <div className="px-5 py-4">
                    <div className="label-caps">Billing cycle</div>
                    <div className="mt-1.5 flex items-center gap-2 text-sm font-[600] capitalize text-ink">
                      <CalendarDays className="h-4 w-4 text-ink-4" aria-hidden />
                      {currentPlan?.interval ?? "—"}
                    </div>
                  </div>
                  <div className="px-5 py-4">
                    <div className="label-caps">Renewal</div>
                    <div className="mt-1.5 text-sm font-[600] text-ink">{renewalLabel}</div>
                  </div>
                </div>

                <div className="px-5 py-5">
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <div className="label-caps">Included capacity</div>
                      <h3 className="mt-1.5 text-md font-[600] tracking-[-0.015em] text-ink">
                        What this plan covers
                      </h3>
                    </div>
                    <Link
                      href="/pricing"
                      className="inline-flex items-center gap-1.5 text-sm font-[550] text-brand transition-colors hover:text-brand-hover"
                    >
                      Compare plans <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </div>

                  {entitlements.length > 0 ? (
                    <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                      {entitlements.map((entry) => (
                        <li key={entry.label} className="rounded-lg border border-edge bg-surface-2 px-4 py-3.5">
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-xs bg-ok-bg text-ok" aria-hidden>
                              <Check className="h-3 w-3" />
                            </span>
                            <div className="min-w-0">
                              <div className="text-xs capitalize text-ink-3">{entry.label}</div>
                              <div className="mt-0.5 text-base font-[620] tabular text-ink">{entry.value}</div>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-4 rounded-lg border border-dashed border-edge-strong bg-surface-2 px-4 py-5 text-sm text-ink-3">
                      Plan capacity is managed by Platform Administration.
                    </p>
                  )}
                </div>
              </section>

              {printUsage && (
                <Card>
                  <CardHeader
                    title="Print usage"
                    subtitle="1 admitted Gateway job = 1 print credit."
                    icon={<CreditCard className="h-4 w-4" />}
                    actions={
                      printUsage.limit !== "unlimited" ? (
                        <StatusBadge
                          tone={usageTone}
                          label={printUsage.remaining === 0 ? "Limit reached" : `${printUsage.remaining.toLocaleString()} remaining`}
                        />
                      ) : (
                        <StatusBadge tone="ok" label="Unlimited" />
                      )
                    }
                  />
                  <div className="px-5 py-5">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                      <div className="text-2xl font-[640] leading-none tracking-[-0.02em] text-ink tabular">
                        {printUsage.used.toLocaleString()}
                        {printUsage.limit !== "unlimited" && (
                          <span className="text-ink-4"> / {printUsage.limit.toLocaleString()}</span>
                        )}
                      </div>
                      <div className="text-xs text-ink-3">
                        {printUsage.periodEnd ? `Current period ends ${formatDate(printUsage.periodEnd)}` : "Current billing period"}
                      </div>
                    </div>
                    {printUsage.limit !== "unlimited" && (
                      <Progress
                        className="mt-3"
                        value={usagePct}
                        tone={usageTone}
                        label={`${printUsage.used} of ${printUsage.limit} print jobs used`}
                      />
                    )}
                    {printUsage.remaining === 0 && (
                      <p className="mt-3 text-sm font-[550] text-bad">
                        The print credit limit for this period is exhausted. New jobs are rejected
                        until the period resets or the plan is upgraded.
                      </p>
                    )}
                  </div>
                </Card>
              )}

              {sub && (attentionStatuses.includes(sub.status) || sub.status === "past_due" || (sub.cancelAtPeriodEnd && sub.status === "active" && sub.currentPeriodEnd)) && (
                <div className="space-y-3">
                  {sub.status === "past_due" && <WarnLine text="The latest payment is past due. Printing remains active during Stripe recovery, but service can be interrupted if the subscription becomes unpaid or canceled. Update the payment method in the Customer Portal." />}
                  {sub.status === "unpaid" && <WarnLine text="Stripe has marked the subscription unpaid. Printing is paused until the outstanding payment is resolved in the Customer Portal." />}
                  {sub.status === "paused" && <WarnLine text="Stripe has paused the subscription. Add a valid payment method, then resume the subscription." />}
                  {sub.status === "incomplete" && <WarnLine text="The initial subscription payment is incomplete. Continue the existing Checkout session or resolve the payment action before printing can start." />}
                  {sub.cancelAtPeriodEnd && sub.status === "active" && sub.currentPeriodEnd && <WarnLine text={`Cancellation is scheduled for ${formatDate(sub.currentPeriodEnd)}. Resume below to keep the plan.`} />}
                </div>
              )}
            </div>

            <aside className="space-y-5">
              <Card id="billing-actions">
                <CardHeader
                  title="Billing controls"
                  subtitle="Portal, cancellation and checkout actions."
                  icon={<Receipt className="h-4 w-4" />}
                />
                <div className="px-5 py-5">
                  <BillingActions
                    hasSubscription={hasActivePlan && hasStripeSubscription}
                    cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd}
                    subscriptionStatus={sub?.status}
                    canOpenPortal={hasStripeSubscription}
                    checkoutUrl={sub?.checkoutSessionUrl}
                  />
                </div>
              </Card>

              <Card>
                <CardHeader title="How charging works" icon={<CreditCard className="h-4 w-4" />} />
                <ul className="space-y-3 px-5 py-5 text-sm text-ink-2">
                  <li className="flex gap-2.5">
                    <span className="mt-1.5"><span className="status-dot bg-ink-4" /></span>
                    <span>Stripe handles payment methods, invoices and receipts. Yaseir never stores card data.</span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="mt-1.5"><span className="status-dot bg-ink-4" /></span>
                    <span>Plan changes are prorated by Stripe at the next billing cycle.</span>
                  </li>
                  <li className="flex gap-2.5">
                    <span className="mt-1.5"><span className="status-dot bg-ink-4" /></span>
                    <span>Print credits count admitted Gateway jobs — test pages included.</span>
                  </li>
                </ul>
              </Card>
            </aside>
          </div>
        </div>
      </PageContainer>
    </>
  );
}

function WarnLine({ text }: { text: string }) {
  return (
    <Callout tone="warn" icon={<AlertTriangle className="h-4 w-4" />}>
      {text}
    </Callout>
  );
}
