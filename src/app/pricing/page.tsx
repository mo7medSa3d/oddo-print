import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { getManagerCookieName, validateManagerClaims, verifyManagerToken } from "../../lib/manager-auth";
import { ArrowRight, Check, CreditCard, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

function entitlementLabel(value: string) {
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

  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);

  let currentPlanId: string | null = null;
  let currentPlanName: string | null = null;

  if (claims) {
    const subscription = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, claims.tenantId),
    });
    if (subscription) {
      currentPlanId = subscription.planId;
      const current = rows.find((plan) => plan.id === subscription.planId);
      currentPlanName = current?.name ?? subscription.planId;
    }
  }

  const destination = (planId: string) => claims ? `/billing?plan=${encodeURIComponent(planId)}` : "/signup";

  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      <header className="mx-auto max-w-3xl text-center">
        <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">
          <CreditCard className="h-3.5 w-3.5 text-brand" /> Plans & capacity
        </div>
        <h1 className="mt-4 text-[38px] font-bold leading-[1.08] tracking-[-0.045em] text-ink sm:text-[50px]">
          Choose the capacity your workspace needs
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-7 text-ink-3">
          Compare the public Yasser plans side by side. Your current plan is marked automatically.
        </p>
      </header>

      {currentPlanId && (
        <div className="mx-auto mt-7 flex max-w-[1280px] items-center justify-between gap-4 rounded-[12px] border border-brand-subtle-border bg-brand-subtle px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-white text-brand shadow-xs">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-brand-subtle-text">Current plan</div>
              <div className="truncate text-[13px] font-semibold text-ink">{currentPlanName}</div>
            </div>
          </div>
          <Link href="/billing" className="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] font-semibold text-brand-subtle-text hover:text-brand-hover">
            Back to Billing <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="mx-auto mt-12 max-w-xl rounded-[14px] border border-dashed border-edge-strong bg-surface px-6 py-12 text-center shadow-card">
          <div className="text-[14px] font-semibold text-ink">No public plans are configured</div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">A Platform Admin needs to publish a plan before it can be selected.</p>
        </div>
      ) : (
        <div className="mx-auto mt-8 grid max-w-[1280px] gap-4 lg:grid-cols-3">
          {rows.map((plan) => {
            const isCurrent = plan.id === currentPlanId;
            const entries = Object.entries(plan.entitlements ?? {}).filter(([, value]) => value !== false).slice(0, 8);

            return (
              <article
                key={plan.id}
                className={`group relative flex min-h-[540px] flex-col overflow-hidden rounded-[16px] border bg-surface shadow-card transition-all duration-180 hover:-translate-y-px hover:shadow-lg ${
                  isCurrent ? "border-brand ring-1 ring-brand/10" : "border-edge hover:border-edge-accent"
                }`}
              >
                {isCurrent && <div className="h-1 bg-brand" aria-hidden="true" />}

                <div className="border-b border-edge bg-surface-2/55 px-6 py-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="text-[21px] font-semibold tracking-[-0.03em] text-ink">{plan.name}</h2>
                        {isCurrent && (
                          <span className="rounded-full border border-ok-edge bg-ok-bg px-2 py-0.5 text-[10px] font-semibold text-ok">
                            Current
                          </span>
                        )}
                      </div>
                      {plan.description && (
                        <p className="mt-2 max-w-[36ch] text-[13px] leading-relaxed text-ink-3">{plan.description}</p>
                      )}
                    </div>
                  </div>

                  <div className="mt-5 flex items-baseline gap-2">
                    <span className="text-[15px] font-bold uppercase tracking-[0.03em] text-ink">
                      {plan.currency ? plan.currency.toUpperCase() : "USD"}
                    </span>
                    <span className="text-[12px] text-ink-3">
                      billed {plan.interval ?? "month"}
                    </span>
                  </div>
                </div>

                <div className="flex-1 px-6 py-6">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">Included capacity</div>
                  <dl className="mt-3 divide-y divide-edge">
                    {entries.length > 0 ? entries.map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between gap-4 py-3">
                        <dt className="flex min-w-0 items-center gap-2 text-[13px] text-ink-2">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok-bg text-ok">
                            <Check className="h-3 w-3" />
                          </span>
                          <span className="capitalize">{entitlementLabel(key)}</span>
                        </dt>
                        <dd className="shrink-0 text-[13px] font-semibold tabular-nums text-ink">{entitlementValue(value)}</dd>
                      </div>
                    )) : (
                      <div className="py-8 text-[13px] text-ink-3">Entitlements are managed by Platform Admin.</div>
                    )}
                  </dl>
                </div>

                <div className="border-t border-edge px-6 py-5">
                  {isCurrent ? (
                    <div className="flex h-11 w-full items-center justify-center rounded-[10px] border border-edge bg-surface-2 text-[13px] font-semibold text-ink-2">
                      Your current plan
                    </div>
                  ) : (
                    <Link
                      href={destination(plan.id)}
                      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-brand px-4 text-[13.5px] font-semibold text-white shadow-sm transition-all duration-150 hover:bg-brand-hover hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20"
                    >
                      {claims ? "Choose plan" : "Get started"}
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  )}
                  <p className="mt-2.5 text-center text-[11px] text-ink-4">
                    {isCurrent ? "No change is required." : claims ? "Continue through secure billing." : "Checkout opens securely through Stripe."}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="mx-auto mt-10 flex max-w-[1280px] flex-col gap-3 rounded-[14px] border border-edge bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-ink">Need to manage the subscription you already have?</div>
          <p className="mt-0.5 text-[12px] text-ink-3">Billing shows your current plan, renewal state, entitlements, and account controls.</p>
        </div>
        <Link
          href={claims ? "/billing" : "/login"}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[9px] border border-edge bg-surface px-3 text-[12.5px] font-semibold text-ink-2 transition hover:border-edge-strong hover:bg-surface-2 hover:text-ink"
        >
          {claims ? "Open Billing" : "Sign in"}
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
