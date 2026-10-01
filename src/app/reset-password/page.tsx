"use client";

import { Suspense, useState } from "react";
import { useI18n } from "../../i18n/react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, ErrorState, Skeleton } from "../../components/ui";

function ResetPasswordContent() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [pw, setPw] = useState("");
  const { t } = useI18n();
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: pw }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErr(typeof data.error === "string" ? data.error : t("auth.reset.failed"));
        return;
      }
      setDone(true);
      setTimeout(() => router.replace("/login"), 700);
    } catch {
      setErr(t("auth.reset.failedBody"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      subtitle={t("auth.forgot.eyebrow")}
      eyebrow={t("auth.forgot.eyebrow")}
      title={t("auth.reset.title")}
      description={t("auth.reset.description")}
    >
      {done ? (
        <Callout tone="ok" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} title={t("auth.reset.updatedTitle")}>
          {t("auth.reset.takingYou")}{" "}
          <Link href="/login" className="font-[600] underline">
            {t("auth.reset.continueNow")}
          </Link>
          .
        </Callout>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Field
            label={t("auth.reset.password")}
            htmlFor="password"
            hint={t("auth.passwordHint")}
            required
          >
            <Input
              id="password"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              minLength={12}
              autoComplete="new-password"
              autoFocus
              required
            />
          </Field>

          {err && <ErrorState title={t("auth.reset.failed")} message={err} />}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            size="lg"
            loading={loading}
            icon={loading ? undefined : <ArrowRight className="h-4 w-4" />}
          >
            {loading ? t("auth.reset.submitting") : t("auth.reset.submit")}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export default function ResetPassword() {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <AuthShell subtitle={t("auth.forgot.eyebrow")}>
          <div className="space-y-4" role="status" aria-label={t("auth.reset.loadingAria")}>
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="mt-6 h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <span className="sr-only">{t("auth.reset.loadingShort")}</span>
          </div>
        </AuthShell>
      }
    >
      <ResetPasswordContent />
    </Suspense>
  );
}
