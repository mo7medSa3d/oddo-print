"use client";

import { Suspense, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Field, Input } from "../../components/ui";

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
    <AuthShell subtitle="Workspace invitation">
      <section className="overflow-hidden rounded-[16px] border border-edge-strong bg-surface shadow-lg">
        <div className="border-b border-edge bg-surface-2/55 px-6 py-6">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-4">Workspace invitation</div>
          <h1 className="mt-2 text-[26px] font-bold tracking-[-0.035em] text-ink">Accept invitation</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">Use the email address the invitation was sent to.</p>
        </div>
        <form className="space-y-5 p-6 sm:p-7" onSubmit={submit}>
          <Field label="Email" htmlFor="invitation-email">
            <Input id="invitation-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} autoComplete="email" required />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy} icon={<ArrowRight className="h-4 w-4" />}>
            {busy ? "Accepting…" : "Accept invitation"}
          </Button>
        </form>
        {message && (
          <p
            ref={feedbackRef}
            role={succeeded ? "status" : "alert"}
            tabIndex={-1}
            className={`mx-6 mb-6 rounded-[10px] border px-4 py-3 text-[12.5px] outline-none ${succeeded ? "border-ok-edge bg-ok-bg text-ok" : "border-bad-edge bg-bad-bg text-bad"}`}
          >
            {message}
          </p>
        )}
        <div className="border-t border-edge px-6 py-4">
          <Link className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3 hover:text-ink" href="/login">
            Sign in <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>
    </AuthShell>
  );
}

export default function Invite() {
  return (
    <Suspense fallback={
      <AuthShell subtitle="Workspace invitation">
        <div className="rounded-[14px] border border-edge bg-surface p-8 text-center text-[13px] text-ink-3 shadow-card">Loading invitation…</div>
      </AuthShell>
    }>
      <InviteContent />
    </Suspense>
  );
}
