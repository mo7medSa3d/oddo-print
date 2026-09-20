import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getManagerCookieName, verifyManagerToken, validateManagerClaims } from "../../lib/manager-auth";
import ReleaseReadinessClient from "./release-readiness-client";

export const dynamic = "force-dynamic";

export default async function ReleaseReadinessPage() {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) redirect("/login");

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-7 sm:px-6 lg:py-8">
      <header className="mb-7 border-b border-edge pb-6">
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-ink">Release Readiness Dashboard</h1>
        <p className="mt-1.5 max-w-3xl text-[15px] leading-relaxed text-ink-3">
          P0 must-close before Production: Real Print Certification, Capability Matrix, Agent Health, Windows Service Recovery, Queue Health + Spooler linking, Job Timeline, Distributed Tracing.
        </p>
      </header>
      <ReleaseReadinessClient />
    </div>
  );
}
