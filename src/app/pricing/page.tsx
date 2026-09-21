import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../../db";
import { plans } from "../../db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import {
  getManagerCookieName,
  validateManagerClaims,
  verifyManagerToken,
} from "../../lib/manager-auth";
import { Check, ArrowRight, ShieldCheck, Zap } from "lucide-react";

export const dynamic = "force-dynamic";

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
  const destination = claims ? "/billing" : "/signup";

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6 py-12 sm:py-16">
      <header className="mx-auto max-w-3xl text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          <ShieldCheck className="h-3.5 w-3.5" /> Plans enforced server-side
        </div>
        <h1 className="mt-6 text-[36px] font-bold tracking-[-0.03em] leading-tight text-ink">Simple plans for production print ops</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-3">No fake usage. Limits are enforced by Gateway — agents, printers, jobs per minute, concurrent jobs. Choose what matches your fleet.</p>
      </header>

      {rows.length === 0 ? (
        <div className="mx-auto mt-12 max-w-xl rounded-[14px] border border-dashed border-edge bg-surface p-8 text-center text-[14px] text-ink-3">No public plans configured yet. Contact Platform Admin.</div>
      ) : (
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {rows.map((plan, idx) => {
            const isPopular = idx === 1;
            return (
              <article key={plan.id} className={`relative flex flex-col rounded-[16px] border p-6 shadow-card transition-all hover:shadow-card-hover hover:-translate-y-[2px] ${isPopular ? "border-brand bg-gradient-to-br from-white to-brand-50/50 shadow-[0_8px_32px_rgba(37,99,235,0.12)]" : "border-edge bg-surface"}`}>
                {isPopular && <div className="absolute -top-3 left-6 inline-flex items-center gap-1 rounded-full bg-brand px-3 py-1 text-[11px] font-semibold text-white shadow-sm"><Zap className="h-3 w-3" /> Most popular</div>}
                <div>
                  <h2 className="text-[18px] font-bold tracking-tight text-ink">{plan.name}</h2>
                  {plan.description && <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{plan.description}</p>}
                  <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-surface-2 border border-edge px-2.5 py-1 text-[11px] font-medium text-ink-3">
                    {plan.currency ? plan.currency.toUpperCase() : "USD"} {plan.interval ? `• ${plan.interval}` : ""}
                  </div>
                </div>

                <div className="mt-6 flex-1 rounded-[12px] border border-edge bg-surface-2 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Included</div>
                  <dl className="mt-3 space-y-2.5">
                    {Object.entries(plan.entitlements ?? {}).slice(0, 6).map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between gap-3 text-[13px]">
                        <dt className="flex items-center gap-2 text-ink-3 capitalize">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ok-bg border border-ok-edge text-ok"><Check className="h-3 w-3" /></span>
                          {key.replace(/^max_/, "").replace(/_/g, " ")}
                        </dt>
                        <dd className="font-semibold tabular-nums text-ink">{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>

                <Link href={destination} className={`mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-[10px] text-[14px] font-semibold transition ${isPopular ? "bg-brand text-white shadow-sm hover:bg-brand-hover" : "border border-edge bg-surface text-ink hover:bg-surface-2"}`}>
                  {claims ? "Open billing" : "Get started"} <ArrowRight className="h-4 w-4" />
                </Link>
                <div className="mt-3 text-center text-[11px] text-ink-3">Stripe checkout • No fake values</div>
              </article>
            );
          })}
        </div>
      )}

      <div className="mx-auto mt-16 max-w-3xl rounded-[14px] border border-edge bg-surface-2 p-6 text-center">
        <div className="text-[13px] font-semibold text-ink">All plans include</div>
        <div className="mt-3 flex flex-wrap justify-center gap-2 text-[11px]">
          {["Durable queue", "Claim fencing", "Idempotency", "Audit logs", "Multi-tenant isolation", "Odoo 19 integration", "Windows Agent"].map((f) => (
            <span key={f} className="rounded-full border border-edge bg-surface px-3 py-1 font-medium text-ink-2">{f}</span>
          ))}
        </div>
        {!claims && (
          <div className="mt-5 text-[13px] text-ink-3">
            Already have an account?{" "}
            <Link href="/login" className="font-semibold text-brand hover:underline">Sign in</Link>
          </div>
        )}
      </div>
    </div>
  );
}
