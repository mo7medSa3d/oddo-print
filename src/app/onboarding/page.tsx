"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/react";
import type { Translator } from "../../i18n/translate";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  CreditCard,
  KeyRound,
  Printer,
  Server,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { codeMessageKey } from "../../lib/api-error-keys";
import {
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  StatusBadge,
} from "../../components/ui";

type Plan = {
  id: string;
  name: string;
  currency: string | null;
  interval: string | null;
  entitlements: Record<string, unknown>;
};

// Built per render, not at module scope: `t` comes from the useI18n hook and
// does not exist until the component runs. A module-level constant would also
// freeze these strings at first evaluation, so they would never follow a
// language switch.
function nextSteps(t: Translator) {
  return [
    {
      icon: Server,
      title: t("onboarding.step.agent"),
      text: t("onboarding.step.agentText"),
    },
    {
      icon: KeyRound,
      title: t("onboarding.step.odoo"),
      text: t("onboarding.step.odooText"),
    },
    {
      icon: Printer,
      title: t("onboarding.step.job"),
      text: t("onboarding.step.jobText"),
    },
  ];
}

export default function Onboarding() {
  const [name, setName] = useState("");
  const { t, tc, formatNumber } = useI18n();
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
      throw new Error(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "onboarding.plansUnavailable"));
    }
    return Array.isArray(data.plans) ? data.plans : [];
  }, []);

  const loadPlans = useCallback(async () => {
    setPlansLoading(true);
    setPlansError("");
    try {
      const nextPlans = await fetchPlans();
      const requestedPlanId = new URLSearchParams(window.location.search).get("plan") ?? "";
      setPlans(nextPlans);
      setPlanId((current) => {
        if (current && nextPlans.some((plan) => plan.id === current)) return current;
        if (requestedPlanId && nextPlans.some((plan) => plan.id === requestedPlanId)) return requestedPlanId;
        return nextPlans[0]?.id ?? "";
      });
    } catch (error) {
      setPlans([]);
      setPlanId("");
      setPlansError(error instanceof Error ? error.message : t("onboarding.plansUnavailable"));
    } finally {
      setPlansLoading(false);
    }
  }, [fetchPlans]);

  useEffect(() => {
    let cancelled = false;
    const requestedPlanId = new URLSearchParams(window.location.search).get("plan") ?? "";
    void fetchPlans()
      .then((nextPlans) => {
        if (cancelled) return;
        setPlans(nextPlans);
        setPlanId((current) => {
          if (current && nextPlans.some((plan) => plan.id === current)) return current;
          if (requestedPlanId && nextPlans.some((plan) => plan.id === requestedPlanId)) return requestedPlanId;
          return nextPlans[0]?.id ?? "";
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setPlans([]);
        setPlanId("");
        setPlansError(error instanceof Error ? error.message : t("onboarding.plansUnavailable"));
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
      setErr(t("onboarding.chooseNameAndPlan"));
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
        throw new Error(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "onboarding.failed"));
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
        throw new Error(typeof checkoutData.error === "string" ? checkoutData.error : t("onboarding.checkoutUnavailable"));
      }
      window.location.href = checkoutData.url;
    } catch (error) {
      setErr(error instanceof Error ? error.message : t("onboarding.failed"));
    } finally {
      setLoading(false);
    }
  }

  const canContinue = name.trim().length >= 2 && !!planId && !plansLoading && !plansError;
  const selectedPlan = plans.find((plan) => plan.id === planId) ?? null;

  return (
    <main className="ambient-surface min-h-screen px-4 py-10 sm:px-6 lg:py-14">
      <div className="mx-auto w-full max-w-[1080px]">
        <header className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 rounded-sm border border-edge-accent bg-brand-subtle px-3 py-1.5 text-xs font-[600] text-brand-subtle-text">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            {t("onboarding.eyebrow")}
          </span>
          <h1 className="mt-4 text-4xl font-[670] tracking-[-0.035em] text-ink sm:text-5xl">
            {t("onboarding.heading")}
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-ink-3">
            {t("onboarding.intro")}
          </p>
        </header>

        <div className="mt-9 grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.85fr)]">
          <Card>
            <CardHeader
              title={t("onboarding.sectionTitle")}
              subtitle={t("onboarding.sectionSubtitle")}
              icon={<Building2 className="h-4 w-4" />}
              actions={
                <ol className="flex items-center gap-2 text-xs font-[600] text-ink-3" aria-label={t("onboarding.progressAria")}>
                  <li className="inline-flex items-center gap-1.5">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-2xs font-[700] text-brand-contrast">1</span>
                    {t("onboarding.stepWorkspace")}
                  </li>
                  <li aria-hidden className="h-px w-4 bg-edge-strong" />
                  <li className="inline-flex items-center gap-1.5">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-edge-strong bg-surface-2 text-2xs font-[700] text-ink-3">2</span>
                    {t("onboarding.stepPlan")}
                  </li>
                </ol>
              }
            />

            <div className="space-y-6 px-5 py-6">
              <Field
                label={t("onboarding.workspaceName")}
                htmlFor="workspace-name"
                hint={t("onboarding.nameHint")}
                required
              >
                <Input
                  id="workspace-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  minLength={2}
                  maxLength={120}
                  autoComplete="organization"
                  placeholder={t("onboarding.namePlaceholder")}
                  required
                  autoFocus
                  disabled={loading}
                />
              </Field>

              <fieldset disabled={loading}>
                <legend className="flex w-full items-end justify-between gap-4 pb-3">
                  <span className="text-sm font-[600] text-ink">{t("onboarding.choosePlanLegend")}</span>
                  {plans.length > 0 && (
                    <span className="text-xs font-[550] text-ink-3">{tc("onboarding.plansAvailable", plans.length, { count: formatNumber(plans.length) })}</span>
                  )}
                </legend>

                {plansLoading ? (
                  <div className="grid gap-3 md:grid-cols-2" role="status" aria-label={t("onboarding.loadingPlansAria")}>
                    {[0, 1].map((item) => (
                      <div key={item} className="space-y-3 rounded-xl border border-edge bg-surface-2 p-4">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-3 w-20" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-3/4" />
                      </div>
                    ))}
                    <span className="sr-only">{t("onboarding.loadingPlansShort")}</span>
                  </div>
                ) : plansError ? (
                  <ErrorState
                    title={t("onboarding.plansLoadFailed")}
                    message={plansError}
                    retry={() => void loadPlans()}
                  />
                ) : plans.length === 0 ? (
                  <EmptyState
                    icon={<CreditCard className="h-5 w-5" />}
                    title={t("onboarding.noPlans")}
                    description={t("onboarding.noPlansBody")}
                  />
                ) : (
                  <div role="radiogroup" aria-label={t("onboarding.choosePlanAria")} className="grid gap-3 md:grid-cols-2">
                    {plans.map((plan) => {
                      const selected = planId === plan.id;
                      const included = Object.entries(plan.entitlements ?? {}).slice(0, 4);
                      return (
                        <button
                          key={plan.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          disabled={loading}
                          onClick={() => setPlanId(plan.id)}
                          className={`rounded-xl border p-4 text-start transition-[border-color,background-color,box-shadow] duration-[160ms] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)] ${
                            selected
                              ? "border-brand bg-brand-subtle shadow-xs"
                              : "border-edge bg-surface hover:border-edge-strong hover:bg-surface-2"
                          } ${loading ? "pointer-events-none opacity-60" : ""}`}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="text-md font-[620] text-ink">{plan.name}</div>
                              <div className="mt-1 text-xs font-[550] text-ink-3">
                                {plan.currency ? plan.currency.toUpperCase() : "—"}
                                {plan.interval ? ` / ${plan.interval}` : ""}
                              </div>
                            </div>
                            {selected ? (
                              <CheckCircle2 className="h-5 w-5 shrink-0 text-brand" aria-hidden />
                            ) : (
                              <span className="h-4 w-4 shrink-0 rounded-full border border-edge-strong" aria-hidden />
                            )}
                          </div>
                          {included.length > 0 && (
                            <dl className="mt-3.5 space-y-2 border-t border-edge-subtle pt-3 text-xs">
                              {included.map(([key, value]) => (
                                <div key={key} className="flex items-center justify-between gap-4">
                                  <dt className="capitalize text-ink-3">
                                    {key.replace(/^max_/, "").replace(/_/g, " ")}
                                  </dt>
                                  <dd className="font-[600] tabular text-ink">
                                    {typeof value === "boolean" ? (value ? t("onboarding.included") : t("onboarding.notIncluded")) : String(value)}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </fieldset>

              {err && (
                <Callout tone="bad" title={t("onboarding.setupFailedTitle")} icon={<AlertTriangle className="h-4 w-4" />}>
                  {err}
                </Callout>
              )}
            </div>

            <div className="flex flex-col gap-3 border-t border-edge-subtle px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink-3">
                {selectedPlan ? (
                  <>
                    {t("onboarding.selectedPrefix")} <span className="font-[600] text-ink">{selectedPlan.name}</span>{" "}
                    {t("onboarding.selectedTail")}
                  </>
                ) : (
                  t("onboarding.choosePlan")
                )}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  variant="primary"
                  disabled={!canContinue || loading}
                  loading={loading}
                  onClick={() => void submit(true)}
                  icon={loading ? undefined : <ArrowRight className="h-4 w-4" />}
                >
                  {t("onboarding.startFreeTrial")}
                </Button>
                <Button variant="secondary" disabled={!canContinue || loading} onClick={() => void submit(false)}>
                  {t("onboarding.continueToCheckout")}
                </Button>
              </div>
            </div>
          </Card>

          <aside className="space-y-5">
            <Card>
              <CardHeader
                title={t("onboarding.whatsNext")}
                subtitle={t("onboarding.whatsNextSubtitle")}
                icon={<Sparkles className="h-4 w-4" />}
              />
              <ol className="space-y-4 px-5 py-5">
                {nextSteps(t).map((step, index) => (
                  <li key={step.title} className="flex gap-3">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-edge bg-surface-2 text-ink-3">
                      <step.icon className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2">
                        <h3 className="text-sm font-[600] text-ink">{step.title}</h3>
                        <span className="font-mono text-2xs tabular text-ink-4">0{index + 1}</span>
                      </div>
                      <p className="mt-0.5 text-sm leading-relaxed text-ink-3">{step.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>

            <Callout tone="info" title={t("onboarding.noCard")}>
              Start with a trial, add a payment method only when you are ready to subscribe. Print
              credits and limits follow the selected plan.
            </Callout>

            <div className="flex items-center gap-2 text-sm text-ink-3">
              <StatusBadge tone="ok" label={t("onboarding.odooReady")} size="sm" />
              <span>{t("onboarding.downloadsIncluded")}</span>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
