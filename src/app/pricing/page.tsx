import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { ArrowRight, Check } from "lucide-react";

export const dynamic = "force-dynamic";

function entitlementLabel(value: string) {
  if (value === "max_prints_per_period") return "Print jobs per period";
  if (value === "max_agents") return "Agents";
  if (value === "max_printers") return "Printers";
  if (value === "max_jobs_per_minute") return "Jobs per minute";
  if (value === "max_concurrent_jobs") return "Concurrent jobs";
  return value.replace(/^max_/, "").replace(/_/g, " ");
}

function entitlementValue(value: unknown) {
  if (value === "unlimited") return "Unlimited";
  if (typeof value === "boolean") return value ? "Included" : "Not included";
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

export default async function Pricing() {
  const rows = await db
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
    .where(and(isNotNull(plans.stripePriceId), eq(plans.isActive, true), eq(plans.isPublic, true)))
    .orderBy(asc(plans.displayOrder), asc(plans.name));

  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get("cust_session")?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );

  let currentPlanId: string | null = null;

  if (claims) {
    const subscription = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, claims.tenantId),
    });
    if (subscription) {
      currentPlanId = subscription.planId;
    }
  }

  const destination = (planId: string) => claims ? `/billing?plan=${encodeURIComponent(planId)}` : `/signup?plan=${encodeURIComponent(planId)}`;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-10 sm:px-8 lg:py-14">
      <header className="max-w-[640px]">
        <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">Plans</p>
        <h1 className="mt-2.5 text-[30px] font-bold leading-[1.12] tracking-[-0.025em] text-ink sm:text-[36px]">
          Choose the plan that fits your operation
        </h1>
        <p className="mt-3 max-w-[600px] text-[14px] leading-[1.7] text-ink-2">
          Compare plans by agent capacity, printer capacity, and print volume. Billing is handled through Stripe; capacity is enforced by the Gateway.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="mt-10 max-w-[560px] rounded-[10px] border border-dashed border-edge bg-surface px-6 py-10 text-center">
          <div className="text-[14px] font-semibold text-ink">No public plans are configured</div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">A platform administrator needs to publish a plan before it can be selected.</p>
        </div>
      ) : (
        <div className={`mx-auto mt-10 grid max-w-[1100px] gap-px overflow-hidden rounded-[10px] border border-edge bg-edge ${rows.length >= 3 ? "lg:grid-cols-3" : rows.length === 2 ? "sm:grid-cols-2" : "max-w-[560px]"}`}>
          {rows.map((plan) => {
            const isCurrent = plan.id === currentPlanId;
            const entries = Object.entries(plan.entitlements ?? {}).filter(([, value]) => value !== false);

            return (
              <article key={plan.id} className="flex flex-col bg-surface">
                <div className="border-b border-edge px-5 py-5">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{plan.name}</h2>
                    {isCurrent && (
                      <span className="inline-flex items-center rounded-[6px] border border-ok-edge bg-ok-bg px-2 py-0.5 text-[12px] font-semibold text-ok">
                        Current
                      </span>
                    )}
                  </div>
                  {plan.description ? (
                    <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{plan.description}</p>
                  ) : (
                    <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">Capacity is defined by the entitlements below.</p>
                  )}
                  <p className="mt-3 text-[13px] text-ink-3">
                    Billed per {plan.interval ?? "month"} · {(plan.currency ?? "USD").toUpperCase()} · amount set in Stripe
                  </p>
                </div>

                <div className="flex-1 px-5 py-5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Included capacity</h3>
                  <dl className="mt-3 divide-y divide-edge border-y border-edge">
                    {entries.length > 0 ? entries.map(([key, value]) => (
                      <div key={key} className="flex items-baseline justify-between gap-4 py-2.5">
                        <dt className="flex min-w-0 items-start gap-2 text-[13px] text-ink-2">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
                          <span>{entitlementLabel(key)}</span>
                        </dt>
                        <dd className="shrink-0 text-[13px] font-semibold tabular-nums text-ink">{entitlementValue(value)}</dd>
                      </div>
                    )) : (
                      <div className="py-6 text-[13px] text-ink-3">Entitlements are managed by the platform administrator.</div>
                    )}
                  </dl>
                  <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
                    One admitted Gateway print job counts as one print credit. Retries of the same job do not consume another credit.
                  </p>
                </div>

                <div className="border-t border-edge px-5 py-4">
                  {isCurrent ? (
                    <div className="flex h-11 w-full items-center justify-center rounded-[8px] border border-edge bg-surface-2 text-[13px] font-semibold text-ink-2">
                      Your current plan
                    </div>
                  ) : (
                    <Link
                      href={destination(plan.id)}
                      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[8px] bg-brand px-4 text-[13px] font-semibold text-white transition hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                    >
                      {claims ? "Choose plan" : "Get started"}
                      <ArrowRight className="h-4 w-4" aria-hidden />
                    </Link>
                  )}
                  <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
                    {isCurrent ? "No change is required." : claims ? "Continue through secure billing." : "Checkout is handled securely through Stripe."}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <section aria-label="Plan notes" className="mt-8 max-w-[720px] rounded-[10px] border border-edge bg-surface px-5 py-4">
        <h2 className="text-[13px] font-semibold text-ink">How plans work</h2>
        <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-2">
          <li>Capacity limits are enforced by the Gateway before a job or resource is admitted.</li>
          <li>Stripe is the source of truth for billing; the Gateway never stores card details.</li>
          <li>Contact your workspace administrator to change plans or manage payment methods.</li>
        </ul>
      </section>
    </div>
  );
}
