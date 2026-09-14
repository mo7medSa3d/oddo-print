import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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
  const sub = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, claims.tenantId) });
  const plan = sub ? await db.query.plans.findFirst({ where: eq(plans.id, sub.planId), columns: { name: true, currency: true, interval: true } }) : null;
  return <main className="mx-auto max-w-5xl px-4 py-10">
    <h1 className="text-2xl font-bold text-ink">Billing</h1>
    <p className="mt-1 text-sm text-ink-3">Subscription state is synchronized from Stripe webhooks; local state controls runtime entitlements.</p>
    <div className="mt-6 card p-6">
      <div className="grid gap-5 md:grid-cols-3">
        <div><div className="text-xs uppercase tracking-wide text-ink-3">Plan</div><div className="mt-1 font-semibold text-ink">{plan?.name ?? "Not selected"}</div></div>
        <div><div className="text-xs uppercase tracking-wide text-ink-3">Status</div><div className="mt-1 font-semibold text-ink">{sub?.status ?? "No subscription"}</div></div>
        <div><div className="text-xs uppercase tracking-wide text-ink-3">Period end</div><div className="mt-1 font-semibold text-ink">{sub?.currentPeriodEnd?.toLocaleDateString() ?? "—"}</div></div>
      </div>
      <div className="mt-6"><a href="/onboarding" className="inline-flex rounded-lg border border-edge px-4 py-2 text-sm font-semibold">Choose a plan</a></div>
      <div className="mt-4"><BillingActions hasSubscription={!!sub?.stripeCustomerId} cancelAtPeriodEnd={!!sub?.cancelAtPeriodEnd} /></div>
    </div>
  </main>;
}
