"use client";

import { fetchWithTimeout } from "../../lib/fetch-timeout";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, MailCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, ErrorState, focusFirstError } from "../../components/ui";
import { codeMessageKey } from "../../lib/api-error-keys";

export default function Forgot() {
  const [email, setEmail] = useState("");
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (error) focusFirstError(formRef.current);
  }, [error]);

  const submitting = useRef(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetchWithTimeout("/api/auth/forgot-password", {
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
      submitting.current = false;
      setLoading(false);
    }
  }

  return (
    <AuthShell
      subtitle={t("auth.forgot.eyebrow")}
      title={t("auth.forgot.title")}
      description={t("auth.forgot.description")}
      footer={
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-sm font-medium text-ink-3 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
        >
          <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden /> {t("auth.forgot.backToSignIn")}
        </Link>
      }
    >
      {done ? (
        <Callout tone="ok" icon={<MailCheck className="h-4 w-4" aria-hidden />} title={t("auth.forgot.inboxTitle")}>
          {t("auth.forgot.inboxBody")}
        </Callout>
      ) : (
        <form ref={formRef} aria-busy={loading} className="space-y-4" onSubmit={submit}>
          <Field label={t("auth.email")} htmlFor="email" required>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              disabled={loading}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? "forgot-error" : undefined}
              required
            />
          </Field>

          {error && <div id="forgot-error"><ErrorState title={t("auth.forgot.failed")} message={error} /></div>}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            size="lg"
            loading={loading}
            icon={loading ? undefined : <ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
          >
            {loading ? t("auth.forgot.submitting") : t("auth.forgot.submit")}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
