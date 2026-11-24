"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, MailCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, ErrorState, focusFirstError } from "../../components/ui";
import { codeMessageKey } from "../../lib/api-error-keys";
import { fetchWithTimeout } from "../../lib/fetch-timeout";

export default function Signup() {
  const [email, setEmail] = useState("");
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const submitting = useRef(false);
  const router = useRouter();

  useEffect(() => {
    const queryEmail = new URLSearchParams(window.location.search).get("email") ?? "";
    if (!queryEmail) return;
    const frame = window.requestAnimationFrame(() => setEmail(current => current || queryEmail));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (err) focusFirstError(formRef.current);
  }, [err]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setErr("");
    try {
      const search = new URLSearchParams(window.location.search);
      const planId = search.get("plan") ?? "";
      const term = search.get("term") ?? "";
      const inviteToken = search.get("invite") ?? "";
      const response = await fetchWithTimeout("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          displayName,
          planId,
          inviteToken,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErr(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "auth.signup.failed"));
        return;
      }
      setDone(true);
      const next = new URLSearchParams({ email });
      if (planId) next.set("plan", planId);
      if (term === "monthly" || term === "yearly") next.set("term", term);
      if (inviteToken) next.set("invite", inviteToken);
      router.push(`/verify-email?${next.toString()}`);
    } catch {
      setErr(t("auth.signup.failed"));
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }

  return (
    <AuthShell
      subtitle={t("auth.shell.gateway")}
      title={t("auth.signup.title")}
      description={t("auth.signup.description")}
      footer={
        <>
          {t("auth.signup.haveAccount")}{" "}
          <Link href="/login" className="rounded-sm font-semibold text-brand hover:text-brand-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
            {t("auth.signup.signIn")}
          </Link>
        </>
      }
    >
      {done ? (
        <Callout tone="ok" icon={<MailCheck className="h-4 w-4" aria-hidden />} title={t("auth.signup.emailSentTitle")}>
          {t("auth.signup.emailSentPrefix")} <strong className="font-semibold">{email}</strong>.{" "}
          {t("auth.signup.emailSentTail")}{" "}
          <Link className="rounded-sm font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35" href="/login">
            {t("auth.signup.returnToSignIn")}
          </Link>
          .
        </Callout>
      ) : (
        <form ref={formRef} aria-busy={loading} className="space-y-4" onSubmit={submit}>
          <Field label={t("v4.signup.name")} htmlFor="display-name" required>
            <Input
              id="display-name"
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              autoComplete="name"
              autoFocus
              minLength={2}
              maxLength={120}
              disabled={loading}
              aria-invalid={Boolean(err) || undefined}
              aria-describedby={err ? "signup-error" : undefined}
              required
            />
          </Field>
          <Field label={t("auth.email")} htmlFor="email" required>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={loading}
              aria-invalid={Boolean(err) || undefined}
              aria-describedby={err ? "signup-error" : undefined}
              required
            />
          </Field>

          {err ? (
            <div id="signup-error"><ErrorState title={t("auth.signup.failed")} message={err} /></div>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            size="lg"
            loading={loading}
            icon={loading ? undefined : <ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
          >
            {loading ? t("auth.signup.submitting") : t("auth.signup.submit")}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
