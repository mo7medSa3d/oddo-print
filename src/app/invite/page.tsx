"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

export default function Invite() {
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

    try {
      const response = await fetch("/api/team/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email }),
      });
      const data = await response.json();
      setSucceeded(response.ok);
      setMessage(
        response.ok
          ? "Invitation accepted. Sign in to continue."
          : data.error ?? "Invitation failed"
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
    <main className="canvas-wash flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-md p-7">
        <h1 className="text-2xl font-bold text-ink">
          Accept workspace invitation
        </h1>
        <p className="mt-2 text-sm text-ink-3">
          Use the email address the invitation was sent to.
        </p>
        <form
          className="mt-6 space-y-4"
          onSubmit={submit}
          aria-busy={busy}
        >
          <label
            htmlFor="invitation-email"
            className="block text-sm font-semibold text-ink"
          >
            Email
          </label>
          <input
            id="invitation-email"
            className="w-full rounded-lg border border-edge bg-surface p-3 disabled:opacity-50"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            required
          />
          <button
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy}
          >
            {busy ? "Accepting…" : "Accept invitation"}
          </button>
        </form>
        {message && (
          <p
            ref={feedbackRef}
            role={succeeded ? "status" : "alert"}
            tabIndex={-1}
            className="mt-4 text-sm text-ink-2 outline-none"
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
    </main>
  );
}
