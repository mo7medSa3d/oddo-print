import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import SystemHealthClient from "./system-health-client";
import { HeartPulse } from "lucide-react";
import { PageContainer, PageHeader } from "../../components/ui";

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
    <>
      <PageHeader
        width="wide"
        eyebrow="Operations"
        icon={<HeartPulse className="h-4 w-4" />}
        title="System health"
        description="Gateway, database, queue, agents, printers, Odoo and billing — sampled on demand."
      />
      <PageContainer width="wide">
        <SystemHealthClient />
      </PageContainer>
    </>
  );
}
