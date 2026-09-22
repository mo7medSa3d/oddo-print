"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CreditCard, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button, Card, EmptyState, ErrorState, Field, Input } from "../../components/ui";

type Plan = {
  id: string;
  name: string;
  currency: string | null;
  interval: string | null;
  entitlements: Record<string, unknown>;
};

export default function Onboarding() {
  const [name, setName] = useState("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planId, setPlanId] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState("");
  const router = useRouter();

  const fetchPlans = useCallback(async (): Promise<Plan[]> => {
    const response = await fetch("/api/billing/plans", {
      credentials: "include",
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof data.error === "string" ? data.error : "Unable to load available plans.");
    }
    return Array.isArray(data.plans) ? data.plans : [];
  }, []);

  const loadPlans = useCallback(async () => {
    setPlansLoading(true);
    setPlansError("");
    try {
      const nextPlans = await fetchPlans();
      setPlans(nextPlans);
      setPlanId((current) => current && nextPlans.some((plan) => plan.id === current) ? current : nextPlans[0]?.id ?? "");
    } catch (error) {
      setPlans([]);
      setPlanId("");
      setPlansError(error instanceof Error ? error.message : "Unable to load available plans.");
    } finally {
      setPlansLoading(false);
    }
  }, [fetchPlans]);

  useEffect(() => {
    let cancelled = false;
    void fetchPlans()
      .then((nextPlans) => {
        if (cancelled) return;
        setPlans(nextPlans);
        setPlanId((current) => current && nextPlans.some((plan) => plan.id === current) ? current : nextPlans[0]?.id ?? "");
      })
      .catch((error) => {
        if (cancelled) return;
        setPlans([]);
        setPlanId("");
        setPlansError(error instanceof Error ? error.message : "Unable to load available plans.");
      })
      .finally(() => {
        if (!cancelled) setPlansLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPlans]);

  async function submit(trial: boolean) {
    setErr("");
    if (!name.trim() || !planId) {
      setErr("Choose a workspace name and a plan before continuing.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ workspaceName: name.trim(), planId, trial }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Workspace setup failed.");
      }
      if (trial) {
        router.replace("/dashboard");
        return;
      }
      const checkout = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ planId }),
      });
      const checkoutData = await checkout.json().catch(() => ({}));
      if (!checkout.ok || typeof checkoutData.url !== "string") {
        throw new Error(typeof checkoutData.error === "string" ? checkoutData.error : "Checkout is temporarily unavailable.");
      }
      window.location.href = checkoutData.url;
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Workspace setup failed.");
    } finally {
      setLoading(false);
    }
  }

  const canContinue = name.trim().length >= 2 && !!planId && !plansLoading && !plansError;

  return (
    <main className="canvas-wash min-h-screen px-4 py-10 sm:px-6 lg:py-12">
      <div className="mx-auto w-full max-w-[900px]">
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-edge-accent bg-brand-subtle px-3 py-1.5 text-xs font-semibold text-brand-subtle-text">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Workspace setup
          </div>
          <h1 className="mt-4 text-[34px] font-bold tracking-[-0.04em] text-ink sm:text-[42px]">Set up your print workspace</h1>
          <p className="mx-auto mt-2 text-sm leading-6 text-ink-3 sm:text-base">Name your workspace and choose a plan.</p>
        </div>

        <Card className="mt-8 p-6 sm:p-8">
          <div className="grid gap-8">
            <Field label="Workspace name" htmlFor="workspace-name">
              <Input
                id="workspace-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                minLength={2}
                maxLength={120}
                autoComplete="organization"
                placeholder="e.g. Acme Warehouse"
                required
                disabled={loading}
              />
            </Field>

            <div>
              <div className="flex items-end justify-between gap-4">
                <div>
                  <label className="text-sm font-semibold text-ink">Choose a plan</label>
                </div>
                {plans.length > 0 && <span className="text-xs font-medium text-ink-3">{plans.length} available</span>}
              </div>

              {plansLoading ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2" role="status" aria-label="Loading plans">
                  {[0, 1].map((item) => (
                    <div key={item} className="rounded-[14px] border border-edge bg-surface-2 p-5 shadow-xs">
                      <div className="skeleton h-4 w-28" />
                      <div className="mt-3 skeleton h-3 w-20" />
                      <div className="mt-4 skeleton h-3 w-full" />
                      <div className="mt-2 skeleton h-3 w-3/4" />
                    </div>
                  ))}
                  <span className="sr-only">Loading plans…</span>
                </div>
              ) : plansError ? (
                <div className="mt-3"><ErrorState title="Plans could not be loaded" message={plansError} retry={() => void loadPlans()} /></div>
              ) : plans.length === 0 ? (
                <div className="mt-3"><EmptyState icon={<CreditCard className="h-9 w-9" />} title="No plans are available" description="The workspace cannot be activated until a public billing plan is configured." /></div>
              ) : (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {plans.map((plan) => {
                    const selected = planId === plan.id;
                    const included = Object.entries(plan.entitlements ?? {}).slice(0, 4);
                    const cardClass = "rounded-[14px] border p-5 text-left transition-[border-color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)] " +
                      (selected ? "border-brand bg-brand-subtle shadow-xs" : "border-edge bg-surface hover:border-edge-strong hover:bg-surface-2") +
                      (loading ? " pointer-events-none opacity-60" : "");
                    return (
                      <button key={plan.id} type="button" disabled={loading} aria-pressed={selected} onClick={() => setPlanId(plan.id)} className={cardClass}>
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="text-[15px] font-semibold text-ink">{plan.name}</div>
                            <div className="mt-1 text-xs font-medium text-ink-3">
                              {plan.currency ? plan.currency.toUpperCase() : ""}{plan.interval ? " / " + plan.interval : ""}
                            </div>
                          </div>
                          {selected && <CheckCircle2 className="h-5 w-5 shrink-0 text-brand" aria-hidden />}
                        </div>
                        {included.length > 0 && (
                          <div className="mt-4 space-y-2 border-t border-edge pt-3">
                            {included.map(([key, value]) => (
                              <div key={key} className="flex items-center justify-between gap-4 text-xs">
                                <span className="capitalize text-ink-3">{key.replace(/^max_/, "").replace(/_/g, " ")}</span>
                                <span className="font-semibold text-ink">{typeof value === "boolean" ? (value ? "Included" : "Not included") : String(value)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {err && (
              <div className="flex items-start gap-3 rounded-xl border border-bad-edge bg-bad-bg px-4 py-3.5 text-sm text-bad" role="alert">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{err}</span>
              </div>
            )}

            <div className="flex flex-col gap-3 border-t border-edge pt-6 sm:flex-row">
              <Button variant="primary" disabled={!canContinue || loading} loading={loading} onClick={() => void submit(true)} className="sm:flex-1">Start trial</Button>
              <Button variant="secondary" disabled={!canContinue || loading} onClick={() => void submit(false)} className="sm:flex-1">Continue to checkout</Button>
            </div>

          </div>
        </Card>
      </div>
    </main>
  );
}