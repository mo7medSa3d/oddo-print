import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import SystemHealthClient from "./system-health-client";

export const dynamic = "force-dynamic";

export default async function SystemHealthPage() {
  // Workspace auth (not manager-only): customer sessions with agents.read
  // must reach this page like they reach the dashboard — the client below
  // calls /api/system/health, which enforces agents.read anyway.
  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get("cust_session")?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );
  if (!claims) redirect("/login");
  if (!hasManagerPermission(claims, "agents.read")) redirect("/");

  return (
    <div className="mx-auto w-full max-w-[1800px] px-4 py-7 sm:px-6 lg:py-8">
      <header className="mb-7 border-b border-edge pb-6">
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-ink">System Health</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-3">Gateway, database, queue, agents, printers, Odoo, and billing.</p>
      </header>
      <SystemHealthClient />
    </div>
  );
}
