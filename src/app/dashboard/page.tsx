import { logError } from "../../lib/log";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import DashboardClient from "./dashboard-client";
import { JobCleanupButton } from "../../components/JobCleanupButton";
import { Activity, Database, LifeBuoy } from "lucide-react";
import { Button, Callout, PageContainer, PageHeader, StatusBadge } from "../../components/ui";
import { getServerLocale, makeT } from "../../i18n/server";
import { loadDashboardStateForTenant } from "../../lib/dashboard-state";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const t = makeT(await getServerLocale());
  const cookieStore = await cookies();
  const claims = await verifyWorkspaceTokenFromCookieValues(
    cookieStore.get("cust_session")?.value ?? null,
    cookieStore.get(getManagerCookieName())?.value ?? null,
  );
  if (!claims) redirect("/login");
  if (
    !hasManagerPermission(claims, "agents.read") ||
    !hasManagerPermission(claims, "printers.read") ||
    !hasManagerPermission(claims, "jobs.read")
  ) {
    redirect(hasManagerPermission(claims, "billing.read") ? "/billing" : "/");
  }

  let dashboardState: Awaited<ReturnType<typeof loadDashboardStateForTenant>> | null = null;
  let databaseError: string | null = null;

  try {
    dashboardState = await loadDashboardStateForTenant(claims.tenantId);
  } catch (error: unknown) {
    // Dotted event name (aggregation-safe) and a string message — a live
    // Error would serialize as {} and lose the failure reason.
    logError("dashboard.database_load_failed", { error: error instanceof Error ? error.message : String(error) });
    databaseError = t("dashboard.page.databaseLoadFailedLog");
  }

  // Effective permissions drive client controls: read-authorized roles must
  // not be offered mutations that end in predictable 403s, and retired
  // printers must not be offered reactivation the server rejects (C058).
  // Server fences stay authoritative; this only shapes the UI.
  const canMutate = {
    printers: hasManagerPermission(claims, "printers.manage"),
    printersTest: hasManagerPermission(claims, "printers.test"),
    agentsLifecycle: hasManagerPermission(claims, "agents.disable") || hasManagerPermission(claims, "agents.retire"),
    jobsCancel: hasManagerPermission(claims, "jobs.cancel"),
    jobsRetry: hasManagerPermission(claims, "jobs.retry"),
  };

  return (
    <>
      <PageHeader
        width="wide"
        eyebrow={t("dashboard.page.eyebrow")}
        icon={<Activity className="h-4 w-4" />}
        title={t("dashboard.page.title")}
        description={t("dashboard.page.description")}
        meta={
          <StatusBadge
            tone={databaseError ? "bad" : "ok"}
            pulse={false}
            label={databaseError ? t("dashboard.page.dbUnavailableBadge") : t("dashboard.page.snapshotLoaded")}
          />
        }
        actions={
          <>
            <Button variant="ghost" size="sm" href="/system-health" icon={<LifeBuoy className="h-4 w-4" />}>
              {t("dashboard.page.systemHealth")}
            </Button>
            {!databaseError && canMutate.jobsCancel ? <JobCleanupButton /> : null}
          </>
        }
      />

      <PageContainer width="wide">
        {databaseError ? (
          <Callout
            tone="bad"
            title={t("dashboard.page.dbUnavailableTitle")}
            icon={<Database className="h-4 w-4" />}
            action={
              <Button variant="secondary" size="sm" href="/system-health">
                {t("dashboard.page.runDiagnostics")}
              </Button>
            }
          >
            {t("dashboard.page.dbUnavailableBody")}
          </Callout>
        ) : (
          <DashboardClient
            diagnosticActorScope={`${claims.tenantId}:${claims.userId ?? "legacy"}:${claims.role}`}
            initialAgents={dashboardState!.agents}
            initialPrinters={dashboardState!.printers}
            initialJobs={dashboardState!.jobs}
            initialFleet={dashboardState!.fleet}
            databaseError={null}
            canMutate={canMutate}
          />
        )}
      </PageContainer>
    </>
  );
}
