import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { eq } from "drizzle-orm";
import { getManagerCookieName, validateManagerClaims, verifyManagerToken } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import { BillingActions } from "../../components/BillingActions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ checkout?: string | string[] }>;

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) redirect("/login");
  if (!hasManagerPermission(claims, "billing.read")) redirect("/dashboard");

  const params = await searchParams;
  const checkoutState = typeof params.checkout === "string" ? params.checkout : undefined;

  const sub = await db.query.tenantSubscriptions.findFirst({
    where: eq(tenantSubscriptions.tenantId, claims.tenantId),
  });
  const plan = sub
    ? await db.query.plans.findFirst({
        where: eq(plans.id, sub.planId),
        columns: { name: true, currency: true, interval: true, entitlements: true },
      })
    : null;

  const activeStatuses = new Set(["trialing", "active", "past_due", "paused"]);
  const hasActivePlan = !!sub && activeStatuses.has(sub.status);
  const hasStripeSubscription = !!sub?.stripeCustomerId && !!sub?.stripeSubscriptionId;
  const isScheduledForCancellation = hasActivePlan && !!sub?.cancelAtPeriodEnd;
  const isCheckoutPending = sub?.checkoutStatus === "creating" || sub?.checkoutStatus === "open";

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="label-caps">Workspace</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink">Billing</h1>
        <p className="mt-1 text-sm text-ink-3">
          Plan, subscription status and usage limits for this workspace.
        </p>
      </header>

      {checkoutState === "success" && (
        <Notice tone="success" title="Checkout completed">
          Your payment was submitted. Subscription details can take a moment to synchronize from Stripe.
        </Notice>
      )}
      {checkoutState === "cancelled" && (
        <Notice tone="neutral" title="Checkout cancelled">
          No subscription change was applied. You can choose a plan whenever you are ready.
        </Notice>
      )}
      {isCheckoutPending && checkoutState !== "success" && (
        <Notice tone="info" title="Checkout is being processed">
          A billing operation is already in progress for this workspace. Refresh after the payment flow finishes.
        </Notice>
      )}

      <section className="card brand-hairline p-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Summary label="Plan" value={plan?.name ?? "No plan"} />
          <Summary
            label="Status"
            value={sub ? formatStatus(sub.status) : "No subscription"}
            valueTone={statusTone(sub?.status)}
          />
          <Summary
            label={isScheduledForCancellation ? "Ends on" : "Period end"}
            value={sub?.currentPeriodEnd ? sub.currentPeriodEnd.toLocaleDateString() : "—"}
          />
        </div>

        {isScheduledForCancellation && sub?.currentPeriodEnd && (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-800">
            This subscription is scheduled to cancel at the end of the current period on{" "}
            <span className="font-semibold">{sub.currentPeriodEnd.toLocaleDateString()}</span>.
            You can resume it before then.
          </div>
        )}

        {sub?.status === "past_due" && (
          <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-700">
            Payment is past due. Use the Customer Portal to update the payment method or resolve the invoice.
          </div>
        )}

        {sub?.status === "paused" && (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-800">
            The subscription is currently paused. Billing actions below use the current Stripe subscription state.
          </div>
        )}

        {plan && (
          <div className="mt-6 rounded-lg border border-edge bg-surface-2 p-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">Plan limits</div>
              <div className="text-xs text-ink-3">
                {(plan.currency ? plan.currency.toUpperCase() : "") +
                  (plan.interval ? " · billed " + plan.interval : "")}
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(plan.entitlements ?? {}).slice(0, 6).map(([key, value]) => (
                <div key={key} className="rounded-md border border-edge bg-surface px-3 py-2.5">
                  <div className="text-xs capitalize text-ink-3">{formatEntitlementKey(key)}</div>
                  <div className="mt-0.5 text-sm font-semibold text-ink">{formatEntitlementValue(value)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 border-t border-edge pt-5">
          {hasActivePlan ? (
            hasStripeSubscription ? (
              <BillingActions
                hasSubscription={true}
                cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd}
              />
            ) : (
              <div className="rounded-lg border border-edge bg-surface-2 px-4 py-3 text-sm text-ink-2">
                This workspace has an active plan, but no Stripe subscription is linked yet. Billing management will become available when the paid subscription is connected.
              </div>
            )
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                href="/pricing"
                className="inline-flex w-fit rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white focusable"
              >
                Choose a plan
              </Link>
              <span className="text-xs text-ink-3">
                Plans and limits are enforced by the Gateway.
              </span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function Summary({
  label,
  value,
  valueTone = "default",
}: {
  label: string;
  value: string;
  valueTone?: "default" | "success" | "warning" | "danger";
}) {
  const toneClass =
    valueTone === "success"
      ? "text-ok"
      : valueTone === "warning"
        ? "text-warn"
        : valueTone === "danger"
          ? "text-bad"
          : "text-ink";

  return (
    <div className="rounded-lg border border-edge bg-surface-2 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{label}</div>
      <div className={"mt-1 text-sm font-semibold " + toneClass}>{value}</div>
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "success" | "info" | "neutral";
  title: string;
  children: React.ReactNode;
}) {
  const classes = {
    success: "border-ok-edge bg-ok-bg text-ok",
    info: "border-info-edge bg-info-bg text-info",
    neutral: "border-edge bg-surface-2 text-ink-2",
  } as const;

  return (
    <div className={"mb-4 rounded-lg border px-4 py-3 text-sm " + classes[tone]}>
      <div className="font-semibold">{title}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function statusTone(value: string | undefined): "default" | "success" | "warning" | "danger" {
  if (value === "active" || value === "trialing") return "success";
  if (value === "paused") return "warning";
  if (value === "past_due" || value === "cancelled") return "danger";
  return "default";
}

function formatStatus(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatEntitlementKey(value: string) {
  return value.replace(/^max_/, "").replace(/_/g, " ");
}

function formatEntitlementValue(value: unknown) {
  if (typeof value === "boolean") return value ? "Included" : "Not included";
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}
