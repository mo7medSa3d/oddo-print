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
    <div className="mx-auto w-full max-w-[1480px] px-5 py-10 sm:px-8 sm:py-14 lg:px-12">
      <header className="mx-auto max-w-3xl text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          <ShieldCheck className="h-3.5 w-3.5" /> Plans enforced server-side
        </div>
        <h1 className="mt-6 text-[40px] font-bold tracking-[-0.04em] leading-tight text-ink sm:text-[48px]">A plan that scales with every print</h1>
        <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-3">Reliable infrastructure for Odoo print operations — with hard limits, secure agents, and a clear upgrade path as your fleet grows.</p>
      </header>

      {rows.length === 0 ? (
        <div className="mx-auto mt-12 max-w-xl rounded-[14px] border border-dashed border-edge bg-surface p-8 text-center text-[14px] text-ink-3">No public plans configured yet. Contact Platform Admin.</div>
      ) : (
        <div className="mt-14 grid items-stretch gap-6 md:grid-cols-3 lg:gap-8">
          {rows.map((plan, idx) => {
            // The third tier is the growth/scale path and should be the
            // strongest visual anchor on the page.
            const isPopular = idx === 1;
            const isFeatured = idx === 2;
            return (
              <article key={plan.id} className={`relative flex min-h-[430px] flex-col rounded-[20px] border p-7 shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-xl ${isFeatured ? "border-2 border-brand bg-gradient-to-br from-white to-brand-50/50 text-ink shadow-[0_10px_36px_rgba(37,99,235,0.16)]" : isPopular ? "border-brand bg-gradient-to-br from-white to-brand-50/50 shadow-[0_8px_32px_rgba(37,99,235,0.12)]" : "border-edge bg-surface"}`}>
                {isFeatured && <div className="absolute -top-3 left-7 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-300 to-yellow-400 px-3 py-1 text-[11px] font-bold text-slate-950 shadow-lg"><Zap className="h-3 w-3" /> Best for scale</div>}
                {isPopular && !isFeatured && <div className="absolute -top-3 left-6 inline-flex items-center gap-1 rounded-full bg-brand px-3 py-1 text-[11px] font-semibold text-white shadow-sm"><Zap className="h-3 w-3" /> Most popular</div>}
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-[20px] font-bold tracking-tight text-ink">{plan.name}</h2>
                    {isFeatured && <span className="rounded-full border border-brand/20 bg-brand-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-brand">Scale tier</span>}
                  </div>
                  {plan.description && <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{plan.description}</p>}
                  <div className={`mt-3 inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium border-edge bg-surface-2 text-ink-3`}>
                    {plan.currency ? plan.currency.toUpperCase() : "USD"} {plan.interval ? `• ${plan.interval}` : ""}
                  </div>
                </div>

                <div className={`mt-6 flex-1 rounded-[14px] border p-4 ${isFeatured ? "border-brand/20 bg-surface-2" : "border-edge bg-surface-2"}`}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Included</div>
                  <dl className="mt-3 space-y-2.5">
                    {Object.entries(plan.entitlements ?? {}).slice(0, 6).map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between gap-3 text-[13px]">
                        <dt className="flex items-center gap-2 capitalize text-ink-3">
                          <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${isFeatured ? "border-brand/20 bg-brand-50 text-brand" : "border-ok-edge bg-ok-bg text-ok"}`}><Check className="h-3 w-3" /></span>
                          {key.replace(/^max_/, "").replace(/_/g, " ")}
                        </dt>
                        <dd className="font-semibold tabular-nums text-ink">{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>

                <Link href={destination} className={`mt-6 inline-flex h-12 items-center justify-center gap-2 rounded-[11px] text-[14px] font-semibold transition ${isFeatured ? "bg-brand text-white shadow-sm hover:bg-brand-hover" : isPopular ? "bg-brand text-white shadow-sm hover:bg-brand-hover" : "border border-edge bg-surface text-ink hover:bg-surface-2"}`}>
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
