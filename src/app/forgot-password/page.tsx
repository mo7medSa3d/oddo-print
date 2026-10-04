"use client";

import { useState } from "react";
import { useI18n } from "../../i18n/react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, MailCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, ErrorState } from "../../components/ui";
import { codeMessageKey } from "../../lib/api-error-keys";

export default function Forgot() {
  const [email, setEmail] = useState("");
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json().catch(() => ({}));
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        setError(t("errors.tooManyAttempts"));
        return;
      }
      if (!response.ok) {
        setError(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "auth.forgot.sendFailed"));
        return;
      }
      setDone(true);
    } catch {
      setError(t("auth.forgot.sendFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      subtitle={t("auth.forgot.eyebrow")}
      eyebrow={t("auth.forgot.eyebrow")}
      title={t("auth.forgot.title")}
      description={t("auth.forgot.description")}
    >
      {done ? (
        <Callout tone="ok" icon={<MailCheck className="h-4 w-4" aria-hidden />} title={t("auth.forgot.inboxTitle")}>
          {t("auth.forgot.inboxBody")}
        </Callout>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Field label={t("auth.email")} htmlFor="email" required>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              required
            />
          </Field>

          {error && <ErrorState title={t("auth.forgot.failed")} message={error} />}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            size="lg"
            loading={loading}
            icon={loading ? undefined : <ArrowRight className="h-4 w-4" />}
          >
            {loading ? t("auth.forgot.submitting") : t("auth.forgot.submit")}
          </Button>
        </form>
      )}

      <Link
        href="/login"
        className="mt-6 inline-flex items-center gap-1.5 text-sm font-[550] text-ink-3 transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {t("auth.forgot.backToSignIn")}
      </Link>
    </AuthShell>
  );
}
