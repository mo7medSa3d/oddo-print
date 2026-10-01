"use client";

import { Suspense, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, MailCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, Skeleton } from "../../components/ui";

function InviteContent() {
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
      const data = await response.json().catch(() => ({}));
      setSucceeded(response.ok);
      setMessage(
        response.ok
          ? "Invitation accepted. Sign in to continue."
          : typeof data.error === "string"
            ? data.error
            : "Invitation failed",
      );
    } catch {
      setSucceeded(false);
      setMessage("Invitation failed");
    } finally {
      setBusy(false);
      requestAnimationFrame(() => feedbackRef.current?.focus());
    }
  }

  return (
    <AuthShell
      subtitle="Workspace invitation"
      eyebrow="Workspace invitation"
      title="Join this workspace"
      description="Confirm the email address the invitation was sent to."
      footer={
        <Link
          className="inline-flex items-center gap-1.5 font-[550] text-ink-3 transition-colors hover:text-ink"
          href="/login"
        >
          Sign in <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      }
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Email" htmlFor="invitation-email" required>
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
          {busy ? "Accepting…" : "Accept invitation"}
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
            title={succeeded ? "Invitation accepted" : "Invitation not accepted"}
          >
            {message}
          </Callout>
        </div>
      )}
    </AuthShell>
  );
}

export default function Invite() {
  return (
    <Suspense
      fallback={
        <AuthShell subtitle="Workspace invitation">
          <div className="space-y-4" role="status" aria-label="Loading invitation">
            <Skeleton className="h-7 w-52" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="mt-6 h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <span className="sr-only">Loading invitation…</span>
          </div>
        </AuthShell>
      }
    >
      <InviteContent />
    </Suspense>
  );
}
