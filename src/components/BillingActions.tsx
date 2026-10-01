"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CreditCard, ExternalLink, RotateCcw } from "lucide-react";
import { Button, Callout, ConfirmDialog, StatusBadge } from "./ui";

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
    cache: "no-store",
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

/**
 * Billing lifecycle actions (portal, checkout, resume, cancel).
 *
 * Behaviour is unchanged from the original implementation — same endpoints,
 * same request bodies, same navigation semantics — but the controls now follow
 * the shared button hierarchy and destructive actions are confirmed in a real
 * dialog instead of a bare modal footer.
 */
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

  const openPortal = () =>
    run("portal", async () => {
      const data = await post("/api/billing/portal");
      if (typeof data.url !== "string" || !data.url) throw new Error("Billing portal URL was not returned");
      window.location.href = data.url;
    });

  return (
    <>
      <div className="space-y-4">
        {selectedPlan && (
          <section className="rounded-lg border border-brand-subtle-border bg-brand-subtle px-4 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="label-caps text-brand-subtle-text">Selected plan</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-md font-[600] text-ink">{selectedPlan.name}</span>
                  <StatusBadge size="sm" tone="brand" label={hasSubscription ? "Change plan" : "New subscription"} />
                </div>
                <div className="mt-1 text-sm text-ink-3">
                  {selectedPlan.currency?.toUpperCase() ?? "USD"} · per {selectedPlan.interval ?? "month"}
                </div>
              </div>
              <Button
                variant="primary"
                onClick={continueWithSelectedPlan}
                disabled={busy !== ""}
                loading={busy === "selected-plan"}
                icon={<ArrowRight className="h-4 w-4" aria-hidden />}
                className="shrink-0"
              >
                {busy === "selected-plan"
                  ? "Opening…"
                  : hasSubscription
                    ? "Continue to billing"
                    : "Continue to checkout"}
              </Button>
            </div>
          </section>
        )}

        <div className="flex flex-wrap gap-2.5">
          <Button
            variant="secondary"
            disabled={!canOpenPortal || busy !== ""}
            loading={busy === "portal"}
            onClick={openPortal}
            icon={<CreditCard className="h-4 w-4" aria-hidden />}
            title={canOpenPortal ? "Open the Stripe customer portal" : "Stripe portal is unavailable for this workspace"}
          >
            {busy === "portal" ? "Opening…" : "Customer portal"}
            {canOpenPortal && busy !== "portal" && (
              <ExternalLink className="ml-1 h-3.5 w-3.5 text-ink-4" aria-hidden />
            )}
          </Button>

          {hasSubscription && subscriptionStatus !== "paused" && !cancelAtPeriodEnd && (
            <Button
              variant="danger"
              disabled={busy !== ""}
              onClick={() => setConfirmCancel(true)}
            >
              Cancel at period end
            </Button>
          )}

          {hasSubscription && (cancelAtPeriodEnd || subscriptionStatus === "paused") && (
            <Button
              variant="primary"
              disabled={busy !== ""}
              loading={busy === "resume"}
              onClick={() =>
                run("resume", async () => {
                  await post("/api/billing/resume");
                  router.refresh();
                })
              }
              icon={<RotateCcw className="h-4 w-4" aria-hidden />}
            >
              {busy === "resume" ? "Updating…" : "Resume subscription"}
            </Button>
          )}
        </div>

        {!selectedPlan && subscriptionStatus === "incomplete" && checkoutUrl && (
          <Button
            variant="primary"
            href={checkoutUrl}
            icon={<ArrowRight className="h-4 w-4" aria-hidden />}
          >
            Continue existing checkout
          </Button>
        )}

        {error && (
          <Callout tone="bad" title="Billing request failed">
            <span role="alert">{error}</span>
          </Callout>
        )}
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => {
          if (!busy) setConfirmCancel(false);
        }}
        onConfirm={() =>
          run("cancel", async () => {
            await post("/api/billing/cancel");
            setConfirmCancel(false);
            router.refresh();
          })
        }
        busy={busy === "cancel"}
        tone="danger"
        title="Cancel subscription?"
        description="Your subscription stays active until the end of the current billing period."
        confirmLabel="Cancel at period end"
        cancelLabel="Keep subscription"
      >
        <div className="space-y-3 text-sm leading-relaxed text-ink-2">
          <p>
            This does not end service immediately — Stripe keeps the subscription active through the
            current period.
          </p>
          <p>
            You can return here and choose <span className="font-[600] text-ink">Resume subscription</span>{" "}
            before the period ends.
          </p>
        </div>
      </ConfirmDialog>
    </>
  );
}
