import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { ArrowRight, Check, CreditCard, DatabaseZap, Receipt } from "lucide-react";
import { Button, Callout, Card, StatusBadge } from "../../components/ui";
import { BrandMark } from "../../components/brand";
import { ThemeToggle } from "../../components/ThemeToggle";
import { logError } from "../../lib/log";

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
  let rows: Array<{
    id: string;
    name: string;
    description: string | null;
    entitlements: unknown;
    currency: string | null;
    interval: string | null;
    displayOrder: number;
  }> = [];
  let catalogUnavailable = false;

  try {
    rows = await db
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
  } catch (error: unknown) {
    // The catalog is the only thing this page needs from the database. If it is
    // unreachable the page still renders, with an explicit unavailable state
    // instead of an empty catalog that looks like "no plans exist".
    logError("pricing.catalog_load_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    catalogUnavailable = true;
  }

  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get("cust_session")?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );

  let currentPlanId: string | null = null;

  if (claims && !catalogUnavailable) {
    const subscription = await db.query.tenantSubscriptions.findFirst({
      where: eq(tenantSubscriptions.tenantId, claims.tenantId),
    });
    if (subscription) {
      currentPlanId = subscription.planId;
    }
  }

  const destination = (planId: string) => claims ? `/billing?plan=${encodeURIComponent(planId)}` : `/signup?plan=${encodeURIComponent(planId)}`;
  const columns = rows.length >= 3 ? "lg:grid-cols-3" : rows.length === 2 ? "sm:grid-cols-2" : "";

  return (
    <div className="min-h-screen bg-app">
      <header className="glass-chrome sticky top-0 z-40 border-b border-edge">
        <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center gap-4 px-6 sm:px-8">
          <Link href="/" className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
            <BrandMark title="Yaseir" subtitle="Print Manager" size="sm" showWordmark />
          </Link>
          <nav className="ml-auto flex items-center gap-2" aria-label="Pricing navigation">
            <Link
              href="/"
              className="hidden h-9 items-center rounded-sm px-3 text-sm font-[550] text-ink-2 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink sm:inline-flex"
            >
              Product
            </Link>
            <ThemeToggle />
            {claims ? (
              <Button variant="primary" size="md" href="/dashboard" icon={<ArrowRight className="h-4 w-4" />}>
                Open console
              </Button>
            ) : (
              <>
                <Link
                  href="/login"
                  className="hidden h-9 items-center rounded-sm px-3.5 text-sm font-[550] text-ink-2 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink sm:inline-flex"
                >
                  Sign in
                </Link>
                <Button variant="primary" size="md" href="/signup">
                  Start trial
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1200px] px-6 py-12 sm:px-8 lg:py-16">
        <header className="max-w-[640px]">
          <p className="text-eyebrow">Plans</p>
          <h1 className="mt-2.5 text-4xl font-[670] leading-[1.1] tracking-[-0.035em] text-ink sm:text-5xl">
            Choose the plan that fits your operation
          </h1>
          <p className="mt-3.5 max-w-[600px] text-base leading-[1.65] text-ink-2">
            Compare plans by agent capacity, printer capacity and print volume. Billing is handled
            through Stripe; capacity is enforced by the Gateway before a job is admitted.
          </p>
        </header>

        {catalogUnavailable ? (
          <Callout tone="warn" title="Plan catalog temporarily unavailable" className="mt-10 max-w-[600px]">
            <p className="leading-relaxed">
              The gateway could not read the plan catalog from the database. Pricing and plan limits
              are unchanged — refresh this page in a moment to try again.
            </p>
            <Button variant="secondary" size="sm" href="/pricing" className="mt-3" icon={<DatabaseZap className="h-4 w-4" aria-hidden />}>
              Retry
            </Button>
          </Callout>
        ) : rows.length === 0 ? (
          <Card className="mt-10 max-w-[520px]">
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-edge bg-surface-2 text-ink-3">
                <CreditCard className="h-5 w-5" aria-hidden />
              </span>
              <h2 className="mt-4 text-md font-[620] text-ink">No public plans are configured</h2>
              <p className="mt-2 max-w-[44ch] text-sm leading-relaxed text-ink-3">
                A platform administrator needs to publish a plan before it can be selected here.
              </p>
              <Button variant="secondary" size="sm" href="/" className="mt-5">
                Back to product
              </Button>
            </div>
          </Card>
        ) : (
          <div className={`mt-10 grid gap-4 ${columns}`}>
            {rows.map((plan) => {
              const isCurrent = plan.id === currentPlanId;
              const entries = Object.entries(plan.entitlements ?? {}).filter(([, value]) => value !== false);

              return (
                <article
                  key={plan.id}
                  className={`card flex flex-col ${isCurrent ? "border-brand shadow-card" : ""}`}
                >
                  <div className="border-b border-edge-subtle px-5 py-5">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-lg font-[640] tracking-[-0.015em] text-ink">{plan.name}</h2>
                      {isCurrent && <StatusBadge tone="ok" label="Current plan" size="sm" />}
                    </div>
                    {plan.description ? (
                      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{plan.description}</p>
                    ) : (
                      <p className="mt-1.5 text-sm leading-relaxed text-ink-3">
                        Capacity is defined by the entitlements below.
                      </p>
                    )}
                    <p className="mt-3 flex items-center gap-2 text-xs text-ink-3">
                      <Receipt className="h-3.5 w-3.5 text-ink-4" aria-hidden />
                      Billed per {plan.interval ?? "month"} · {(plan.currency ?? "USD").toUpperCase()} ·
                      amount set in Stripe
                    </p>
                  </div>

                  <div className="flex-1 px-5 py-5">
                    <h3 className="label-caps">Included capacity</h3>
                    {entries.length > 0 ? (
                      <dl className="mt-3 divide-y divide-edge-subtle border-y border-edge-subtle">
                        {entries.map(([key, value]) => (
                          <div key={key} className="flex items-baseline justify-between gap-4 py-2.5">
                            <dt className="flex min-w-0 items-start gap-2 text-sm text-ink-2">
                              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
                              <span>{entitlementLabel(key)}</span>
                            </dt>
                            <dd className="shrink-0 text-sm font-[620] tabular text-ink">
                              {entitlementValue(value)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="mt-3 text-sm text-ink-3">
                        Entitlements are managed by the platform administrator.
                      </p>
                    )}
                    <p className="mt-3 text-xs leading-relaxed text-ink-3">
                      One admitted Gateway print job counts as one print credit. An idempotent retry of
                      the same job does not consume another credit.
                    </p>
                  </div>

                  <div className="border-t border-edge-subtle px-5 py-4">
                    {isCurrent ? (
                      <div className="flex h-10 w-full items-center justify-center rounded-sm border border-edge bg-surface-2 text-sm font-[600] text-ink-2">
                        Your current plan
                      </div>
                    ) : (
                      <Button
                        variant="primary"
                        href={destination(plan.id)}
                        className="w-full"
                        icon={<ArrowRight className="h-4 w-4" />}
                      >
                        {claims ? "Choose this plan" : "Get started"}
                      </Button>
                    )}
                    <p className="mt-2 text-xs leading-relaxed text-ink-3">
                      {isCurrent
                        ? "No change is required."
                        : claims
                          ? "Continue through secure billing."
                          : "Checkout is handled securely through Stripe."}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <section aria-label="How plans work" className="mt-10 max-w-[760px]">
          <h2 className="text-md font-[620] text-ink">How plans work</h2>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-2">
            <li className="flex gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
              Capacity limits are enforced by the Gateway before a job or resource is admitted.
            </li>
            <li className="flex gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
              Stripe is the source of truth for billing; the Gateway never stores card details.
            </li>
            <li className="flex gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
              Workspace owners can change plans or manage payment methods from Billing at any time.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
