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

export default async function BillingPage() {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) redirect("/login");
  if (!hasManagerPermission(claims, "billing.read")) redirect("/dashboard");

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

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="label-caps">Workspace</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink">Billing</h1>
        <p className="mt-1 text-sm text-ink-3">
          Plan, subscription status and usage limits for this workspace.
        </p>
      </header>

      <section className="card brand-hairline p-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Summary label="Plan" value={plan?.name ?? "No plan"} />
          <Summary label="Status" value={sub ? formatStatus(sub.status) : "No subscription"} />
          <Summary
            label="Period end"
            value={sub?.currentPeriodEnd ? sub.currentPeriodEnd.toLocaleDateString() : "—"}
          />
        </div>

        {plan && (
          <div className="mt-6 rounded-lg border border-edge bg-surface-2 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">Plan limits</div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {Object.entries(plan.entitlements ?? {}).slice(0, 6).map(([key, value]) => (
                <div key={key} className="text-sm text-ink-2">
                  <span className="font-semibold text-ink">{formatEntitlementKey(key)}:</span>{" "}
                  {String(value)}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          {hasActivePlan ? (
            hasStripeSubscription ? (
              <BillingActions hasSubscription={true} cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd} />
            ) : (
              <p className="text-sm text-ink-2">
                Your plan is active. Stripe billing management will become available when a paid subscription is connected.
              </p>
            )
          ) : (
            <>
              <Link
                href="/pricing"
                className="inline-flex w-fit rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white focusable"
              >
                Choose a plan
              </Link>
              <span className="text-xs text-ink-3">Plans and limits are enforced by the Gateway.</span>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-2 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}

function formatStatus(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatEntitlementKey(value: string) {
  return value.replace(/^max_/, "").replace(/_/g, " ");
}
