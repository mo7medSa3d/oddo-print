import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import { getServerLocale, makeT } from "../../i18n/server";
import { PageContainer, PageHeader } from "../../components/ui";
import CaptureTestsClient from "./capture-tests-client";

export const dynamic = "force-dynamic";

export default async function CaptureTestsPage() {
  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get("cust_session")?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );
  if (!claims) redirect("/login");
  if (!hasManagerPermission(claims, "jobs.read")) {
    redirect(hasManagerPermission(claims, "billing.read") ? "/billing" : "/dashboard");
  }

  const t = makeT(await getServerLocale());
  return (
    <>
      <PageHeader
        width="wide"
        eyebrow={t("nav.section.integration")}
        title={t("captureMonitor.title")}
        description={t("captureMonitor.pageDescription")}
        icon={<ClipboardCheck className="h-4 w-4" aria-hidden />}
      />
      <PageContainer width="wide">
        <CaptureTestsClient
          canPreview={hasManagerPermission(claims, "jobs.payload.read")}
          canDelete={hasManagerPermission(claims, "jobs.cancel")}
        />
      </PageContainer>
    </>
  );
}
