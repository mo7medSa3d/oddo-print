"use client";

import { Suspense, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BrandMark, Button, Field, Input } from "../../components/ui";

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
            : "Invitation failed"
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
    <div className="card w-full max-w-md p-7">
      <BrandMark size="lg" title="Yasser" subtitle="Workspace invitation" />
      <h1 className="mt-5 text-2xl font-bold text-ink">
        Accept workspace invitation
      </h1>
      <p className="mt-2 text-sm text-ink-3">
        Use the email address the invitation was sent to.
      </p>
      <form className="mt-6 space-y-5" onSubmit={submit} aria-busy={busy}>
        <Field label="Email" htmlFor="invitation-email">
          <Input
            id="invitation-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            autoComplete="email"
            required
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {busy ? "Accepting…" : "Accept invitation"}
        </Button>
      </form>
      {message && (
        <p
          ref={feedbackRef}
          role={succeeded ? "status" : "alert"}
          tabIndex={-1}
          className={`mt-4 rounded-xl border px-4 py-3 text-sm outline-none ${
            succeeded
              ? "border-ok-edge bg-ok-bg text-ok"
              : "border-bad-edge bg-bad-bg text-bad"
          }`}
        >
          {message}
        </p>
      )}
      <Link
        className="mt-5 inline-block text-sm font-semibold text-brand"
        href="/login"
      >
        Sign in
      </Link>
    </div>
  );
}

export default function Invite() {
  return (
    <main className="canvas-wash flex min-h-screen items-center justify-center px-4">
      <Suspense
        fallback={
          <div className="card w-full max-w-md p-7 text-sm text-ink-3">
            Loading invitation…
          </div>
        }
      >
        <InviteContent />
      </Suspense>
    </main>
  );
}
