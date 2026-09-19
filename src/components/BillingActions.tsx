"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./ui";

async function post(path: string) {
  const res = await fetch(path, { method: "POST", credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Billing request failed");
  return data;
}

export function BillingActions({
  hasSubscription,
  cancelAtPeriodEnd,
}: {
  hasSubscription: boolean;
  cancelAtPeriodEnd: boolean;
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

  return (
    <>
      <div className="space-y-3">
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
            className="rounded-lg border border-edge bg-surface px-4 py-2 text-sm font-semibold text-ink transition hover:bg-surface-2 disabled:opacity-50"
          >
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
