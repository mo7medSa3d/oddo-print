import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../../db";
import { plans } from "../../db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { getManagerCookieName, validateManagerClaims, verifyManagerToken } from "../../lib/manager-auth";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { StatusBadge } from "../../components/ui";

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
    })
    .from(plans)
    .where(and(isNotNull(plans.stripePriceId), eq(plans.isActive, true), eq(plans.isPublic, true)))
    .orderBy(asc(plans.displayOrder), asc(plans.name));

  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  const destination = (planId: string) => claims ? `/billing?plan=${encodeURIComponent(planId)}` : "/signup";

  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      <header className="mx-auto max-w-3xl text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] text-ink-3 shadow-xs">
          <ShieldCheck className="h-3.5 w-3.5 text-brand" /> Plans
        </div>
        <h1 className="mt-5 text-[38px] font-bold leading-[1.08] tracking-[-0.04em] text-ink sm:text-[50px]">
          Simple plans for reliable print infrastructure
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-7 text-ink-3">
          Choose the workspace capacity you need. Stripe handles checkout and the subscription remains the source of truth for billing.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="mx-auto mt-12 max-w-xl rounded-[14px] border border-dashed border-edge-strong bg-surface px-6 py-12 text-center shadow-card">
          <div className="text-[14px] font-semibold text-ink">No public plans are configured</div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">A Platform Admin needs to publish a plan before it can be selected.</p>
        </div>
      ) : (
        <div className="mx-auto mt-12 grid max-w-[1280px] gap-4 lg:grid-cols-3">
          {rows.map((plan) => {
            const entries = Object.entries(plan.entitlements ?? {}).slice(0, 8);
            return (
              <article key={plan.id} className="group flex min-h-[520px] flex-col overflow-hidden rounded-[16px] border border-edge bg-surface shadow-card transition-all duration-180 hover:-translate-y-px hover:border-edge-accent hover:shadow-lg">
                <div className="border-b border-edge bg-surface-2/55 px-6 py-6">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-[20px] font-semibold tracking-[-0.025em] text-ink">{plan.name}</h2>
                      {plan.description && <p className="mt-2 max-w-[34ch] text-[13px] leading-relaxed text-ink-3">{plan.description}</p>}
                    </div>
                    <StatusBadge tone="brand" label="Available" />
                  </div>
                  <div className="mt-5 flex items-center gap-2">
                    <span className="rounded-[8px] border border-edge bg-surface px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">
                      {plan.currency ? plan.currency.toUpperCase() : "USD"}
                    </span>
                    {plan.interval && <span className="text-[12px] text-ink-3">billed {plan.interval}</span>}
                  </div>
                </div>

                <div className="flex-1 px-6 py-6">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">Included capacity</div>
                  <dl className="mt-4 divide-y divide-edge">
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
                  <Link
                    href={destination(plan.id)}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-brand px-4 text-[13.5px] font-semibold text-white shadow-sm transition-all duration-150 hover:bg-brand-hover hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20"
                  >
                    {claims ? "Choose plan" : "Get started"}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <p className="mt-2.5 text-center text-[11px] text-ink-4">Checkout opens securely through Stripe.</p>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="mx-auto mt-10 flex max-w-[1280px] flex-col gap-3 rounded-[14px] border border-edge bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-ink">Need to review your current subscription?</div>
          <p className="mt-0.5 text-[12px] text-ink-3">Open Billing to see the plan state, entitlements, and account actions.</p>
        </div>
        <Link href={claims ? "/billing" : "/login"} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[9px] border border-edge bg-surface px-3 text-[12.5px] font-semibold text-ink-2 transition hover:border-edge-strong hover:bg-surface-2 hover:text-ink">
          {claims ? "Open Billing" : "Sign in"}
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
