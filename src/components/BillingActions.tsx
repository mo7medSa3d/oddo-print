"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, CreditCard, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { Modal } from "./ui";

type PlanOption = {
  id: string;
  name: string;
  displayOrder: number;
  currency: string | null;
  interval: string | null;
  entitlements: Record<string, unknown> | null;
};

async function post(path: string, body?: Record<string, unknown>) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data?.code === "STRIPE_NOT_CONFIGURED"
        ? "Stripe billing is not configured on this Gateway yet."
        : (typeof data?.error === "string" ? data.error : "Billing request failed"),
    );
  }
  return data;
}

export function BillingActions({
  hasSubscription,
  cancelAtPeriodEnd,
  currentPlanId,
  plans,
  selectedPlanId,
}: {
  hasSubscription: boolean;
  cancelAtPeriodEnd: boolean;
  currentPlanId: string | null;
  plans: PlanOption[];
  selectedPlanId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);

  const currentPlan = plans.find((plan) => plan.id === currentPlanId) ?? null;
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId) ?? null;

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Billing request failed");
    } finally {
      setBusy("");
    }
  };

  const choosePlan = (plan: PlanOption) => {
    if (currentPlanId === plan.id && hasSubscription) return;

    if (!hasSubscription) {
      void run(`checkout-${plan.id}`, async () => {
        const data = await post("/api/billing/checkout", { planId: plan.id });
        if (typeof data.url !== "string" || !data.url) {
          throw new Error("Stripe checkout URL was not returned");
        }
        window.location.href = data.url;
      });
      return;
    }

    void run(`portal-${plan.id}`, async () => {
      const data = await post("/api/billing/portal");
      if (typeof data.url !== "string" || !data.url) {
        throw new Error("Billing portal URL was not returned");
      }
      window.location.href = data.url;
    });
  };

  return (
    <>
      <div className="space-y-5">
        {plans.length > 0 && (
          <section className="rounded-[12px] border border-edge bg-surface-2 p-4">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                  <CreditCard className="h-3.5 w-3.5" /> Available plans
                </div>
                <p className="mt-1 text-[12px] text-ink-3">
                  {hasSubscription
                    ? "Higher tiers open the Stripe Customer Portal so the subscription stays managed by Stripe."
                    : "Choose a plan to start Stripe Checkout."}
                </p>
              </div>
              {selectedPlan && selectedPlan.id !== currentPlanId && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand">
                  <Sparkles className="h-3 w-3" /> Selected: {selectedPlan.name}
                </span>
              )}
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {plans.map((plan) => {
                const isCurrent = hasSubscription && currentPlanId === plan.id;
                const isUpgrade = !!currentPlan && plan.displayOrder > currentPlan.displayOrder;
                const isSelected = selectedPlanId === plan.id;

                return (
                  <div
                    key={plan.id}
                    className={`rounded-[12px] border bg-surface p-4 transition ${
                      isSelected ? "border-brand ring-2 ring-brand/10" : "border-edge"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[14px] font-bold text-ink">{plan.name}</div>
                        <div className="mt-1 text-[11px] text-ink-3">
                          {plan.currency?.toUpperCase() ?? "USD"} · {plan.interval ?? "month"}
                        </div>
                      </div>
                      {isCurrent ? (
                        <span className="rounded-full border border-ok-edge bg-ok-bg px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-ok">
                          Current
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-3 space-y-1.5">
                      {Object.entries(plan.entitlements ?? {}).slice(0, 4).map(([key, value]) => (
                        <div key={key} className="flex items-center justify-between gap-3 text-[11px]">
                          <span className="flex items-center gap-1.5 capitalize text-ink-3">
                            <Check className="h-3 w-3 text-ok" />
                            {key.replace(/^max_/, "").replace(/_/g, " ")}
                          </span>
                          <span className="font-semibold tabular-nums text-ink">{String(value)}</span>
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      disabled={!!busy || isCurrent}
                      onClick={() => choosePlan(plan)}
                      className={`mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-[10px] px-3 text-[12px] font-semibold transition disabled:cursor-default disabled:opacity-60 ${
                        isCurrent
                          ? "border border-edge bg-surface-2 text-ink-3"
                          : hasSubscription
                            ? "bg-brand text-white hover:bg-brand-hover"
                            : "bg-brand text-white hover:bg-brand-hover"
                      }`}
                    >
                      {busy === `checkout-${plan.id}` || busy === `portal-${plan.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : isCurrent ? (
                        "Current plan"
                      ) : hasSubscription ? (
                        isUpgrade ? (
                          <>Upgrade <ArrowUpRight className="h-3.5 w-3.5" /></>
                        ) : (
                          <>Change plan <ExternalLink className="h-3.5 w-3.5" /></>
                        )
                      ) : (
                        <>Subscribe <ArrowUpRight className="h-3.5 w-3.5" /></>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={!hasSubscription || !!busy}
            onClick={() =>
              run("portal", async () => {
                const data = await post("/api/billing/portal");
                if (typeof data.url !== "string" || !data.url) {
                  throw new Error("Billing portal URL was not returned");
                }
                window.location.href = data.url;
              })
            }
            className="inline-flex items-center gap-2 rounded-lg border border-edge bg-surface px-4 py-2 text-sm font-semibold text-ink transition hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === "portal" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
            {busy === "portal" ? "Opening…" : "Customer Portal"}
          </button>

          {hasSubscription && !cancelAtPeriodEnd && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setConfirmCancel(true)}
              className="rounded-lg border border-bad-edge bg-bad-bg px-4 py-2 text-sm font-semibold text-bad transition hover:brightness-95 disabled:opacity-50"
            >
              Cancel at period end
            </button>
          )}

          {hasSubscription && cancelAtPeriodEnd && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() =>
                run("resume", async () => {
                  await post("/api/billing/resume");
                  router.refresh();
                })
              }
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-hover disabled:opacity-50"
            >
              {busy === "resume" ? "Updating…" : "Resume subscription"}
            </button>
          )}
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-bad-edge bg-bad-bg px-4 py-3 text-sm text-bad">
            {error}
          </div>
        )}
      </div>

      <Modal
        open={confirmCancel}
        onClose={() => {
          if (!busy) setConfirmCancel(false);
        }}
        title="Cancel subscription?"
        description="Your subscription will remain active until the end of the current billing period."
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmCancel(false)}
              disabled={!!busy}
              className="rounded-lg border border-edge bg-surface px-4 py-2 text-sm font-semibold text-ink transition hover:bg-surface-2 disabled:opacity-50"
            >
              Keep subscription
            </button>
            <button
              type="button"
              onClick={() =>
                run("cancel", async () => {
                  await post("/api/billing/cancel");
                  setConfirmCancel(false);
                  router.refresh();
                })
              }
              disabled={!!busy}
              className="rounded-lg bg-bad-solid px-4 py-2 text-sm font-semibold text-white transition hover:brightness-95 disabled:opacity-50"
            >
              {busy === "cancel" ? "Cancelling…" : "Confirm cancellation"}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-ink-2">
          <p>
            This does not end service immediately. Stripe will keep the subscription active through the current period.
          </p>
          <p>
            You can return here and choose <span className="font-semibold text-ink">Resume subscription</span> before the period ends.
          </p>
        </div>
      </Modal>
    </>
  );
}
