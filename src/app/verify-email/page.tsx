"use client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { BrandMark } from "../../components/ui";

function VerifyEmailContent() {
  const params = useSearchParams();
  const token = params.get("token");
  const email = params.get("email");
  const router = useRouter();
  const [state, setState] = useState<"loading" | "ok" | "error" | "pending">(
    token ? "loading" : email ? "pending" : "error"
  );
  const [msg, setMsg] = useState(
    token ? "Verifying your email…" : email ? `Check your inbox (${email}) for a verification link.` : "Verification link is missing or invalid."
  );

  useEffect(() => {
    if (!token) return;
    fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    }).then(async r => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Verification failed");
      setState("ok");
      setMsg("Email verified. Redirecting to workspace setup…");
      setTimeout(() => router.replace("/onboarding"), 500);
    }).catch(e => {
      setState("error");
      setMsg(e instanceof Error ? e.message : "Verification failed");
    });
  }, [token, router]);

  return (
    <div className="w-full max-w-md card p-7 text-center">
      <BrandMark size="lg" title="Print Gateway" subtitle="Email verification" />
      <h1 className="mt-6 text-2xl font-bold text-ink">
        {state === "loading" ? "Verify your email" : state === "ok" ? "Email verified" : state === "pending" ? "Check your email" : "Verification failed"}
      </h1>
      <p className="mt-2 text-sm text-ink-2">{msg}</p>
      {(state === "error" || state === "pending") && (
        <Link href="/login" className="mt-5 inline-flex font-semibold text-brand">
          Back to sign in
        </Link>
      )}
    </div>
  );
}

export default function VerifyEmail() {
  return (
    <main className="canvas-wash min-h-screen flex items-center justify-center px-4">
      <Suspense fallback={<div className="w-full max-w-md card p-7 text-center">Loading...</div>}>
        <VerifyEmailContent />
      </Suspense>
    </main>
  );
}
