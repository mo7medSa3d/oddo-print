"use client";

import { useState } from "react";
import { useI18n } from "../../i18n/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, MailCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, ErrorState } from "../../components/ui";

export default function Signup() {
  const [email, setEmail] = useState("");
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [accountExists, setAccountExists] = useState(false);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setErr("");
    setAccountExists(false);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          planId: new URLSearchParams(window.location.search).get("plan") ?? "",
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 && data.code === "ACCOUNT_EXISTS") {
        setAccountExists(true);
        return;
      }
      if (!response.ok) throw new Error(data.error ?? t("auth.signup.failed"));
      setDone(true);
      const planId = new URLSearchParams(window.location.search).get("plan") ?? "";
      const next = new URLSearchParams({ email });
      if (planId) next.set("plan", planId);
      router.push(`/verify-email?${next.toString()}`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : t("auth.signup.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      subtitle={t("auth.shell.gateway")}
      eyebrow={t("auth.signup.eyebrow")}
      title={t("auth.signup.title")}
      description={t("auth.signup.description")}
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-[600] text-brand hover:text-brand-hover hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {done ? (
        <Callout tone="ok" icon={<MailCheck className="h-4 w-4" aria-hidden />} title="Check your email">
          We sent a verification link to <strong className="font-[600]">{email}</strong>. Open it to
          continue workspace setup.{" "}
          <Link className="font-[600] underline" href="/login">
            Return to sign in
          </Link>
          .
        </Callout>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Field label={t("auth.email")} htmlFor="email" required>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setAccountExists(false);
              }}
              autoComplete="email"
              autoFocus
              required
            />
          </Field>

          <Field
            label={t("auth.password")}
            htmlFor="password"
            hint={t("auth.passwordHint")}
            required
          >
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              required
            />
          </Field>

          {accountExists ? (
            <Callout tone="brand" title={t("auth.signup.alreadyRegistered")}>
              This email already has a Yaseir account.{" "}
              <Link href="/login" className="font-[600] underline">
                Sign in instead
              </Link>
              .
            </Callout>
          ) : err ? (
            <ErrorState title={t("auth.signup.failed")} message={err} />
          ) : null}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            size="lg"
            loading={loading}
            icon={loading ? undefined : <ArrowRight className="h-4 w-4" />}
          >
            {loading ? t("auth.signup.submitting") : t("auth.signup.submit")}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
