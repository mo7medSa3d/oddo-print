import Link from "next/link";
import { cookies } from "next/headers";
import { db } from "../../db";
import { plans, tenantSubscriptions } from "../../db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { getManagerCookieName, validateManagerClaims, verifyManagerToken } from "../../lib/manager-auth";
import { ArrowRight, Check, CreditCard } from "lucide-react";

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
    <div className="mx-auto w-full max-w-[1440px] px-5 py-8 sm:px-7 lg:px-8 lg:py-12">
      <header className="mx-auto max-w-3xl text-center">
        <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">
          <CreditCard className="h-3.5 w-3.5 text-brand" /> Plans
        </div>
        <h1 className="mt-4 text-[36px] font-bold leading-[1.06] tracking-[-0.045em] text-ink sm:text-[48px]">
          Choose the plan that fits your operation
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[14px] leading-6 text-ink-3">Compare plans by branches, printers, and print capacity.</p>
      </header>

      {rows.length === 0 ? (
        <div className="mx-auto mt-12 max-w-xl rounded-[14px] border border-dashed border-edge-strong bg-surface px-6 py-12 text-center shadow-card">
          <div className="text-[14px] font-semibold text-ink">No public plans are configured</div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">A Platform Admin needs to publish a plan before it can be selected.</p>
        </div>
      ) : (
        <div className="mx-auto mt-8 grid max-w-[1200px] gap-5 lg:grid-cols-3">
          {rows.map((plan, index) => {
            const isCurrent = plan.id === currentPlanId;
            const entries = Object.entries(plan.entitlements ?? {}).filter(([, value]) => value !== false).slice(0, 6);
            const spotlight =
              rows.length >= 3 && index === 0
                ? {
                    label: "Essential",
                    badgeClass:
                      "rounded-[7px] border border-edge-strong bg-surface-2 text-ink-3",
                    icon: "none" as const,
                  }
                : rows.length >= 3 && index === 1
                  ? {
                      label: "Popular",
                      badgeClass:
                        "rounded-full border border-brand-subtle-border bg-brand-subtle text-brand-subtle-text",
                      icon: "none" as const,
                    }
                  : rows.length >= 3 && index === 2
                    ? {
                        label: "Scale",
                        badgeClass:
                          "rounded-[6px] border border-dashed border-info-edge bg-info-bg text-info",
                        icon: "dot" as const,
                      }
                    : rows.length === 2 && index === 0
                      ? {
                          label: "Essential",
                          badgeClass:
                            "rounded-[7px] border border-edge-strong bg-surface-2 text-ink-3",
                          icon: "none" as const,
                        }
                      : rows.length === 2 && index === 1
                        ? {
                            label: "Popular",
                            badgeClass:
                              "rounded-full border border-brand-subtle-border bg-brand-subtle text-brand-subtle-text",
                            icon: "sparkles" as const,
                          }
                        : rows.length === 1
                          ? {
                              label: "Essential",
                              badgeClass:
                                "rounded-[7px] border border-edge-strong bg-surface-2 text-ink-3",
                              icon: "none" as const,
                            }
                          : null;
            const highlighted = rows.length >= 3 && index === 1 && !isCurrent;

            return (
              <article
                key={plan.id}
                className={`group relative flex min-h-[500px] flex-col overflow-hidden rounded-[18px] border bg-surface shadow-card transition-all duration-180 hover:-translate-y-px hover:shadow-md ${
                  isCurrent
                    ? "border-brand ring-1 ring-brand/10"
                    : highlighted
                      ? "border-brand-subtle-border ring-1 ring-brand/15 lg:-translate-y-1 lg:shadow-lg"
                      : "border-edge hover:border-edge-accent"
                }`}
              >
                {spotlight && (
                  <div className="flex items-center justify-center px-4 pb-1 pt-5">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${spotlight.badgeClass}`}
                    >
                      {spotlight.icon === "dot" ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-info-solid" aria-hidden />
                      ) : null}
                      {spotlight.label}
                    </span>
                  </div>
                )}

                <div className="border-b border-dashed border-edge-subtle bg-surface px-6 py-7">
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

                <div className="flex-1 px-6 py-7">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">Included</div>
                  <dl className="mt-3">
                    {entries.length > 0 ? entries.map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between gap-4 border-t border-dashed border-edge-subtle py-3 first:border-t-0">
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

                <div className="border-t border-dashed border-edge-subtle px-6 py-4.5">
                  {isCurrent ? (
                    <div className="flex h-11 w-full items-center justify-center rounded-[10px] border border-edge bg-surface-2 text-[13px] font-semibold text-ink-2">
                      Your current plan
                    </div>
                  ) : (
                    <Link
                      href={destination(plan.id)}
                      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-brand px-4 text-[13.5px] font-semibold text-brand-contrast shadow-sm transition-all duration-150 hover:bg-brand-hover hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20"
                    >
                      {claims ? "Choose plan" : "Get started"}
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  )}
                  <p className="mt-2.5 text-center text-[11px] text-ink-4">
                    {isCurrent ? "No change is required." : claims ? "Continue through secure billing." : "Checkout is handled securely through Stripe."}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      )}

    </div>
  );
}
