import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../../db";
import { plans } from "../../db/schema";
import { eq, isNotNull } from "drizzle-orm";
import {
  getManagerCookieName,
  validateManagerClaims,
  verifyManagerToken,
} from "../../lib/manager-auth";

export const dynamic = "force-dynamic";

export default async function Pricing() {
  const rows = await db
    .select({
      id: plans.id,
      name: plans.name,
      entitlements: plans.entitlements,
      currency: plans.currency,
      interval: plans.interval,
    })
    .from(plans)
    .where(isNotNull(plans.stripePriceId));

  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  const destination = claims ? "/billing" : "/signup";

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <p className="label-caps">Plans</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">Simple plans for print operations</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-3">
          Limits are enforced by the Gateway. Choose the plan that matches the number of runtime resources and print jobs you need.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="card p-6 text-sm text-ink-2">
          No public plans are currently configured.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {rows.map((plan) => (
            <article key={plan.id} className="card flex flex-col p-6">
              <div>
                <h2 className="text-lg font-semibold text-ink">{plan.name}</h2>
                <p className="mt-1 text-sm font-medium text-ink-2">
                  {plan.currency ? plan.currency.toUpperCase() : ""}{plan.interval ? ` / ${plan.interval}` : ""}
                </p>
              </div>

              <div className="mt-5 flex-1 rounded-lg border border-edge bg-surface-2 p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Included</div>
                <dl className="mt-3 space-y-2">
                  {Object.entries(plan.entitlements ?? {}).slice(0, 6).map(([key, value]) => (
                    <div key={key} className="flex items-baseline justify-between gap-4 text-sm">
                      <dt className="capitalize text-ink-3">{key.replace(/^max_/, "").replace(/_/g, " ")}</dt>
                      <dd className="font-semibold text-ink">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <Link
                href={destination}
                className="mt-5 inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white focusable"
              >
                {claims ? "Open billing" : "Get started"}
              </Link>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
