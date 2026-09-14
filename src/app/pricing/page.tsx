import Link from "next/link";
import { db } from "../../db";
import { plans } from "../../db/schema";
import { isNotNull } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function Pricing() {
  const rows = await db.select({ id: plans.id, name: plans.name, entitlements: plans.entitlements, currency: plans.currency, interval: plans.interval })
    .from(plans).where(isNotNull(plans.stripePriceId));
  return <main className="mx-auto max-w-6xl px-4 py-16">
    <div className="text-center"><h1 className="text-4xl font-bold text-ink">Pricing</h1><p className="mt-3 text-ink-2">Plans are configured server-side; print limits are enforced by the Gateway.</p></div>
    {rows.length === 0 ? <div className="mx-auto mt-10 max-w-2xl rounded-xl border border-edge bg-surface p-6 text-center text-sm text-ink-2">No public plans are currently configured. A billing administrator must provision Stripe Price IDs before customer checkout can be enabled.</div> : <div className="mt-10 grid gap-5 md:grid-cols-3">{rows.map((p) => <div key={p.id} className="card p-6"><h2 className="text-lg font-semibold text-ink">{p.name}</h2><p className="mt-2 text-sm text-ink-3">{p.currency ? p.currency.toUpperCase() : ""}{p.interval ? ` / ${p.interval}` : ""}</p><p className="mt-4 text-sm text-ink-2">Server-enforced print and resource entitlements.</p><Link href="/signup" className="mt-6 inline-flex rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">Get started</Link></div>)}</div>}
  </main>;
}
