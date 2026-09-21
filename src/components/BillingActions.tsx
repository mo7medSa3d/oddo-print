"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, CreditCard, ExternalLink, Loader2 } from "lucide-react";
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
        if (typeof data.url !== "string" || !data.url) throw new Error("Stripe checkout URL was not returned");
        window.location.href = data.url;
      });
      return;
    }

    void run(`portal-${plan.id}`, async () => {
      const data = await post("/api/billing/portal");
      if (typeof data.url !== "string" || !data.url) throw new Error("Billing portal URL was not returned");
      window.location.href = data.url;
    });
  };

  return (
    <>
      <div className="space-y-5">
        {plans.length > 0 && (
          <section className="overflow-hidden rounded-[12px] border border-edge bg-surface">
            <div className="flex flex-col gap-2 border-b border-edge bg-surface-2/55 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2 text-[12px] font-semibold text-ink">
                  <CreditCard className="h-4 w-4 text-brand" />
                  Available plans
                </div>
                <p className="mt-1 text-[12px] text-ink-3">
                  {hasSubscription
                    ? "Choose a plan to open Stripe's Customer Portal for the change."
                    : currentPlanId
                      ? "Choose the plan you want to continue with."
                      : "Choose a plan to start Stripe Checkout."}
                </p>
              </div>
              {selectedPlan && selectedPlan.id !== currentPlanId && (
                <span className="text-[11px] font-semibold text-brand">Selected: {selectedPlan.name}</span>
              )}
            </div>

            <div className="divide-y divide-edge">
              {plans.map((plan) => {
                const isCurrentPaid = hasSubscription && currentPlanId === plan.id;
                const isTrialPlan = !hasSubscription && currentPlanId === plan.id;
                const isUpgrade = !!currentPlan && plan.displayOrder > currentPlan.displayOrder;
                const isSelected = selectedPlanId === plan.id;

                return (
                  <div key={plan.id} className={`flex flex-col gap-3 px-4 py-4 transition-colors sm:flex-row sm:items-center sm:justify-between ${isSelected ? "bg-brand-subtle/60" : "hover:bg-surface-2"}`}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[14px] font-semibold tracking-[-0.015em] text-ink">{plan.name}</div>
                        {isCurrentPaid && <span className="rounded-full border border-ok-edge bg-ok-bg px-2 py-0.5 text-[10px] font-semibold text-ok">Current</span>}
                        {isTrialPlan && <span className="rounded-full border border-edge-accent bg-brand-subtle px-2 py-0.5 text-[10px] font-semibold text-brand">Trial</span>}
                      </div>
                      <div className="mt-1 text-[11px] text-ink-3">
                        {plan.currency?.toUpperCase() ?? "USD"} · {plan.interval ?? "month"}
                      </div>
                      {Object.keys(plan.entitlements ?? {}).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
                          {Object.entries(plan.entitlements ?? {}).slice(0, 4).map(([key, value]) => (
                            <span key={key} className="inline-flex items-center gap-1">
                              <Check className="h-3 w-3 text-ok" />
                              <span className="capitalize">{key.replace(/^max_/, "").replace(/_/g, " ")}</span>
                              <strong className="font-semibold tabular-nums text-ink">{String(value)}</strong>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={!!busy || isCurrentPaid}
                      onClick={() => choosePlan(plan)}
                      className={`inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-[9px] px-3.5 text-[12px] font-semibold transition-all duration-150 disabled:cursor-default disabled:opacity-55 ${isCurrentPaid ? "border border-edge bg-surface-2 text-ink-3" : "bg-brand text-white shadow-sm hover:bg-brand-hover hover:shadow-md"}`}
                    >
                      {busy === `checkout-${plan.id}` || busy === `portal-${plan.id}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : isCurrentPaid ? (
                        "Current plan"
                      ) : isTrialPlan ? (
                        "Keep this plan"
                      ) : hasSubscription ? (
                        isUpgrade ? <>Upgrade <ArrowUpRight className="h-3.5 w-3.5" /></> : <>Change plan <ExternalLink className="h-3.5 w-3.5" /></>
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

        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            disabled={!hasSubscription || !!busy}
            onClick={() => run("portal", async () => {
              const data = await post("/api/billing/portal");
              if (typeof data.url !== "string" || !data.url) throw new Error("Billing portal URL was not returned");
              window.location.href = data.url;
            })}
            className="inline-flex h-9 items-center gap-2 rounded-[9px] border border-edge bg-surface px-3.5 text-[12.5px] font-semibold text-ink-2 shadow-xs transition hover:border-edge-strong hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            {busy === "portal" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
            {busy === "portal" ? "Opening…" : "Customer Portal"}
          </button>

          {hasSubscription && !cancelAtPeriodEnd && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setConfirmCancel(true)}
              className="inline-flex h-9 items-center rounded-[9px] border border-bad-edge bg-bad-bg px-3.5 text-[12.5px] font-semibold text-bad transition hover:brightness-95 disabled:opacity-50"
            >
              Cancel at period end
            </button>
          )}

          {hasSubscription && cancelAtPeriodEnd && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => run("resume", async () => {
                await post("/api/billing/resume");
                router.refresh();
              })}
              className="inline-flex h-9 items-center rounded-[9px] bg-brand px-3.5 text-[12.5px] font-semibold text-white transition hover:bg-brand-hover disabled:opacity-50"
            >
              {busy === "resume" ? "Updating…" : "Resume subscription"}
            </button>
          )}
        </div>

        {error && (
          <div role="alert" className="rounded-[10px] border border-bad-edge bg-bad-bg px-4 py-3 text-[12.5px] text-bad">{error}</div>
        )}
      </div>

      <Modal
        open={confirmCancel}
        onClose={() => { if (!busy) setConfirmCancel(false); }}
        title="Cancel subscription?"
        description="Your subscription will remain active until the end of the current billing period."
        footer={
          <>
            <button type="button" onClick={() => setConfirmCancel(false)} disabled={!!busy} className="rounded-[9px] border border-edge bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-surface-2 disabled:opacity-50">
              Keep subscription
            </button>
            <button
              type="button"
              onClick={() => run("cancel", async () => {
                await post("/api/billing/cancel");
                setConfirmCancel(false);
                router.refresh();
              })}
              disabled={!!busy}
              className="rounded-[9px] bg-bad-solid px-4 py-2 text-[13px] font-semibold text-white transition hover:brightness-95 disabled:opacity-50"
            >
              {busy === "cancel" ? "Cancelling…" : "Confirm cancellation"}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-relaxed text-ink-2">
          <p>This does not end service immediately. Stripe will keep the subscription active through the current period.</p>
          <p>You can return here and choose <span className="font-semibold text-ink">Resume subscription</span> before the period ends.</p>
        </div>
      </Modal>
    </>
  );
}
