import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import ReleaseReadinessClient from "./release-readiness-client";
import { ClipboardCheck } from "lucide-react";
import { PageContainer, PageHeader } from "../../components/ui";

export const dynamic = "force-dynamic";

export default async function ReleaseReadinessPage() {
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
        icon={<ClipboardCheck className="h-4 w-4" />}
        title="Release readiness"
        description="Production checks, runtime evidence and outstanding release blockers."
      />
      <PageContainer width="wide">
        <ReleaseReadinessClient />
      </PageContainer>
    </>
  );
}
