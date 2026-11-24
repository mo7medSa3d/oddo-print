import { sessionCookieName } from "../../../lib/session-config";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { validatePlatformClaims, verifyPlatformTokenSignature } from "../../../lib/platform-auth";
import ReleaseReadinessClient from "./release-readiness-client";
import { ClipboardCheck } from "lucide-react";
import { getServerLocale, makeT } from "../../../i18n/server";
import { PageContainer, PageHeader } from "../../../components/ui";

export const dynamic = "force-dynamic";

export default async function ReleaseReadinessPage() {
  // Engineering release evidence is internal, never a customer workspace feature.
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName("platform"))?.value;
  const claims = token ? await validatePlatformClaims(verifyPlatformTokenSignature(token), true) : null;
  if (!claims) notFound();
  const t = makeT(await getServerLocale());

  return (
    <>
      <PageHeader variant="inline"
        width="wide" 
        icon={<ClipboardCheck className="h-4 w-4" />}
        title={t("release.page.title")} 
      />
      <PageContainer width="wide">
        <ReleaseReadinessClient />
      </PageContainer>
    </>
  );
}
