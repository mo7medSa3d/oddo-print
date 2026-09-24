"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CreditCard, ExternalLink, Loader2 } from "lucide-react";
import { Modal } from "./ui";

type PlanOption = {
  id: string;
  name: string;
  currency: string | null;
  interval: string | null;
  entitlements?: Record<string, unknown> | null;
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
  subscriptionStatus,
  canOpenPortal = false,
  checkoutUrl,
  selectedPlan,
}: {
  hasSubscription: boolean;
  cancelAtPeriodEnd: boolean;
  subscriptionStatus?: string | null;
  canOpenPortal?: boolean;
  checkoutUrl?: string | null;
  selectedPlan?: PlanOption | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);

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

  const continueWithSelectedPlan = () => {
    if (!selectedPlan) return;

    void run("selected-plan", async () => {
      if (
        hasSubscription ||
        subscriptionStatus === "paused" ||
        subscriptionStatus === "unpaid" ||
        (subscriptionStatus === "incomplete" && !checkoutUrl && canOpenPortal)
      ) {
        const data = await post("/api/billing/portal");
        if (typeof data.url !== "string" || !data.url) throw new Error("Billing portal URL was not returned");
        window.location.href = data.url;
        return;
      }

      if (subscriptionStatus === "incomplete" && checkoutUrl) {
        window.location.href = checkoutUrl;
        return;
      }

      const data = await post("/api/billing/checkout", { planId: selectedPlan.id });
      if (typeof data.url !== "string" || !data.url) throw new Error("Stripe checkout URL was not returned");
      window.location.href = data.url;
    });
  };

  return (
    <>
      <div className="space-y-4">
        {selectedPlan && (
          <section className="rounded-[12px] border border-brand-subtle-border bg-brand-subtle px-4 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-subtle-text">
                  Selected plan
                </div>
                <div className="mt-1 text-[15px] font-semibold text-ink">{selectedPlan.name}</div>
                <div className="mt-0.5 text-[12px] text-ink-3">
                  {selectedPlan.currency?.toUpperCase() ?? "USD"} · {selectedPlan.interval ?? "month"}
                </div>
              </div>
              <button
                type="button"
                disabled={!!busy}
                onClick={continueWithSelectedPlan}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-brand px-4 text-[12.5px] font-semibold text-white shadow-sm transition hover:bg-brand-hover hover:shadow-md disabled:opacity-50"
              >
                {busy === "selected-plan" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {busy === "selected-plan" ? "Opening…" : hasSubscription ? "Continue to billing" : "Continue to checkout"}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </section>
        )}

        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            disabled={!canOpenPortal || !!busy}
            onClick={() => run("portal", async () => {
              const data = await post("/api/billing/portal");
              if (typeof data.url !== "string" || !data.url) throw new Error("Billing portal URL was not returned");
              window.location.href = data.url;
            })}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-edge bg-surface px-3.5 text-[12.5px] font-semibold text-ink-2 shadow-xs transition hover:border-edge-strong hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            {busy === "portal" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
            {busy === "portal" ? "Opening…" : "Customer Portal"}
{canOpenPortal && <ExternalLink className="h-3 w-3 text-ink-4" />}
          </button>

          {hasSubscription && subscriptionStatus !== "paused" && !cancelAtPeriodEnd && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setConfirmCancel(true)}
              className="inline-flex h-9 items-center rounded-full border border-bad-edge bg-bad-bg px-3.5 text-[12.5px] font-semibold text-bad transition hover:brightness-95 disabled:opacity-50"
            >
              Cancel at period end
            </button>
          )}

          {hasSubscription && (cancelAtPeriodEnd || subscriptionStatus === "paused") && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => run("resume", async () => {
                await post("/api/billing/resume");
                router.refresh();
              })}
              className="inline-flex h-9 items-center rounded-full bg-brand px-3.5 text-[12.5px] font-semibold text-white transition hover:bg-brand-hover disabled:opacity-50"
            >
              {busy === "resume" ? "Updating…" : "Resume subscription"}
            </button>
          )}
        </div>

        {!selectedPlan && subscriptionStatus === "incomplete" && checkoutUrl && (
          <a
            href={checkoutUrl}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-brand px-3.5 text-[12.5px] font-semibold text-white transition hover:bg-brand-hover"
          >
            Continue existing checkout
            <ArrowRight className="h-3.5 w-3.5" />
          </a>
        )}

        {error && (
          <div role="alert" className="rounded-[10px] border border-bad-edge bg-bad-bg px-4 py-3 text-[12.5px] text-bad">
            {error}
          </div>
        )}
      </div>

      <Modal
        open={confirmCancel}
        onClose={() => { if (!busy) setConfirmCancel(false); }}
        title="Cancel subscription?"
        description="Your subscription will remain active until the end of the current billing period."
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmCancel(false)}
              disabled={!!busy}
              className="rounded-[9px] border border-edge bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition hover:bg-surface-2 disabled:opacity-50"
            >
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
