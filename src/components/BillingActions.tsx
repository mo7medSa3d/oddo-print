"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CreditCard, ExternalLink, RotateCcw } from "lucide-react";
import { Button, Callout, ConfirmDialog, StatusBadge } from "./ui";
import { useI18n } from "../i18n/react";
import { billingIntervalLabel } from "../lib/billing-labels";
import type { MessageKey } from "../i18n/messages/en";
import type { Translator } from "../i18n/translate";

type PlanOption = {
  id: string;
  name: string;
  currency: string | null;
  interval: string | null;
  entitlements?: Record<string, unknown> | null;
};


async function post(path: string, body: Record<string, unknown> | undefined, t: Translator) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Keep raw server text out of the interface: the operator sees a plain
    // explanation, the detail stays in the console for support.
    if (typeof data?.error === "string" && data.error) console.warn("billing_request_failed:", data.error);
    throw new Error(
      data?.code === "STRIPE_NOT_CONFIGURED" ? t("billingActions.stripeNotConfigured") : t("billingActions.requestFailed"),
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
  const { t } = useI18n();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("billingActions.requestFailed"));
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
        const data = await post("/api/billing/portal", undefined, t);
        if (typeof data.url !== "string" || !data.url) throw new Error(t("billingActions.portalUrlMissing"));
        window.location.href = data.url;
        return;
      }

      if (subscriptionStatus === "incomplete" && checkoutUrl) {
        window.location.href = checkoutUrl;
        return;
      }

      const data = await post("/api/billing/checkout", { planId: selectedPlan.id }, t);
      if (typeof data.url !== "string" || !data.url) throw new Error(t("billingActions.checkoutUrlMissing"));
      window.location.href = data.url;
    });
  };

  const openPortal = () =>
    run("portal", async () => {
      const data = await post("/api/billing/portal", undefined, t);
      if (typeof data.url !== "string" || !data.url) throw new Error(t("billingActions.portalUrlMissing"));
      window.location.href = data.url;
    });

  return (
    <>
      <div className="space-y-4">
        {selectedPlan && (
          <section className="rounded-sg border border-edge-accent bg-brand-subtle px-4 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="label-caps text-brand-subtle-text">{t("billingActions.selectedPlan")}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-md font-[600] text-ink">{selectedPlan.name}</span>
                  <StatusBadge size="sm" tone="brand" label={hasSubscription ? t("billingActions.changePlan") : t("billingActions.newSubscription")} />
                </div>
                <div className="mt-1 text-sm text-ink-3">
                  {t("billingActions.perInterval", { currency: selectedPlan.currency?.toUpperCase() ?? "USD", interval: billingIntervalLabel(selectedPlan.interval, t) })}
                </div>
              </div>
              <Button
                variant="primary"
                onClick={continueWithSelectedPlan}
                disabled={busy !== ""}
                loading={busy === "selected-plan"}
                icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden />}
                className="shrink-0"
              >
                {busy === "selected-plan"
                  ? t("billingActions.opening")
                  : hasSubscription
                    ? t("billingActions.continueToBilling")
                    : t("billingActions.continueToCheckout")}
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
            title={canOpenPortal ? t("billingActions.portalTitle") : t("billingActions.portalUnavailableTitle")}
          >
            {busy === "portal" ? t("billingActions.opening") : t("billingActions.customerPortal")}
            {canOpenPortal && busy !== "portal" && (
              <ExternalLink className="ms-1 h-3.5 w-3.5 text-ink-4" aria-hidden />
            )}
          </Button>

          {hasSubscription && subscriptionStatus !== "paused" && !cancelAtPeriodEnd && (
            <Button
              variant="danger"
              disabled={busy !== ""}
              onClick={() => setConfirmCancel(true)}
            >
              {t("billingActions.cancelAtPeriodEnd")}
            </Button>
          )}

          {hasSubscription && (cancelAtPeriodEnd || subscriptionStatus === "paused") && (
            <Button
              variant="primary"
              disabled={busy !== ""}
              loading={busy === "resume"}
              onClick={() =>
                run("resume", async () => {
                  await post("/api/billing/resume", undefined, t);
                  router.refresh();
                })
              }
              icon={<RotateCcw className="h-4 w-4" aria-hidden />}
            >
              {busy === "resume" ? t("billingActions.updating") : t("billingActions.resumeSubscription")}
            </Button>
          )}
        </div>

        {!selectedPlan && subscriptionStatus === "incomplete" && checkoutUrl && (
          <Button
            variant="primary"
            href={checkoutUrl}
            icon={<ArrowRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden />}
          >
            {t("billingActions.continueExistingCheckout")}
          </Button>
        )}

        {error && (
          <Callout tone="bad" title={t("billingActions.requestFailed")}>
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
            await post("/api/billing/cancel", undefined, t);
            setConfirmCancel(false);
            router.refresh();
          })
        }
        busy={busy === "cancel"}
        tone="danger"
        title={t("billingActions.cancelTitle")}
        description={t("billingActions.cancelDescription")}
        confirmLabel={t("billingActions.cancelAtPeriodEnd")}
        cancelLabel={t("billingActions.keepSubscription")}
      >
        <div className="space-y-3 text-sm leading-relaxed text-ink-2">
          <p>{t("billingActions.cancelBody1")}</p>
          <p>
            {t("billingActions.cancelBody2")}{" "}
            <span className="font-[600] text-ink">{t("billingActions.resumeSubscription")}</span>{" "}
            {t("billingActions.hint")}
          </p>
        </div>
      </ConfirmDialog>
    </>
  );
}
