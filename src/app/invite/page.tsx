"use client";

import { Suspense, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, MailCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, Skeleton } from "../../components/ui";
import { useI18n } from "../../i18n/react";

function InviteContent() {
  const { t } = useI18n();
  const token = useSearchParams().get("token") ?? "";
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [succeeded, setSucceeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const feedbackRef = useRef<HTMLParagraphElement>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setSucceeded(false);
    try {
      const response = await fetch("/api/team/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email }),
      });
      setSucceeded(response.ok);
      setMessage(
        response.ok
          ? t("invite.accepted")
          : t("invite.failed"),
      );
    } catch {
      setSucceeded(false);
      setMessage(t("invite.failed"));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => feedbackRef.current?.focus());
    }
  }

  return (
    <AuthShell
      subtitle={t("auth.shell.invitation")}
      eyebrow={t("invite.eyebrow")}
      title={t("invite.title")}
      description={t("invite.description")}
      footer={
        <Link
          className="inline-flex items-center gap-1.5 font-[550] text-ink-3 transition-colors hover:text-ink"
          href="/login"
        >
          {t("invite.signIn")} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      }
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field label={t("invite.email")} htmlFor="invitation-email" required>
          <Input
            id="invitation-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            autoComplete="email"
            autoFocus
            required
          />
        </Field>

        <Button
          type="submit"
          variant="primary"
          className="w-full"
          size="lg"
          loading={busy}
          icon={busy ? undefined : <ArrowRight className="h-4 w-4" />}
        >
          {busy ? t("invite.submitting") : t("invite.submit")}
        </Button>
      </form>

      {message && (
        <div
          ref={feedbackRef}
          role={succeeded ? "status" : "alert"}
          tabIndex={-1}
          className="mt-4 outline-none"
        >
          <Callout
            tone={succeeded ? "ok" : "bad"}
            icon={succeeded ? <MailCheck className="h-4 w-4" aria-hidden /> : undefined}
            title={succeeded ? t("invite.acceptedTitle") : t("invite.rejectedTitle")}
          >
            {message}
          </Callout>
        </div>
      )}
    </AuthShell>
  );
}

export default function Invite() {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <AuthShell subtitle={t("auth.shell.invitation")}>
          <div className="space-y-4" role="status" aria-label={t("invite.loading")}>
            <Skeleton className="h-7 w-52" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="mt-6 h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <span className="sr-only">{t("invite.loadingShort")}</span>
          </div>
        </AuthShell>
      }
    >
      <InviteContent />
    </Suspense>
  );
}
