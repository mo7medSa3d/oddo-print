import { logError } from "../../lib/log";
import { db } from "../../db";
import { agents, printers, printJobs } from "../../db/schema";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getManagerCookieName, verifyWorkspaceTokenFromCookieValues } from "../../lib/manager-auth";
import { hasManagerPermission } from "../../lib/authorization";
import DashboardClient from "./dashboard-client";
import { JobCleanupButton } from "../../components/JobCleanupButton";
import { isAgentAvailableForJob } from "../../lib/agent-availability";
import { Activity, Database, LifeBuoy } from "lucide-react";
import { Button, Callout, PageContainer, PageHeader, StatusBadge } from "../../components/ui";
import { getServerLocale, makeT } from "../../i18n/server";

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

  let allAgents: Array<{
    id: string;
    name: string;
    pairingCode: string | null;
    pairingCodeExpiresAt?: Date | null;
    status: string;
    lifecycle: string;
    metadata: unknown;
    lastSeenAt: Date | null;
    createdAt: Date;
    printerCount: number;
  }> = [];
  let allPrinters: Array<typeof printers.$inferSelect> = [];
  type JobMeta = Pick<typeof printJobs.$inferSelect,
    | "id"
    | "tenantId"
    | "destination"
    | "documentType"
    | "agentId"
    | "printerId"
    | "status"
    | "error"
    | "requestedBy"
    | "retries"
    | "deliveryAttempts"
    | "claimedAt"
    | "deliveredAt"
    | "ackedAt"
    | "expiresAt"
    | "createdAt"
    | "updatedAt"
  >;
  let allJobs: JobMeta[] = [];
  let databaseError: string | null = null;

  try {
    allAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        pairingCode: sql<string | null>`NULL`,
        pairingCodeExpiresAt: agents.pairingCodeExpiresAt,
        status: agents.status,
        lifecycle: agents.lifecycle,
        metadata: agents.metadata,
        lastSeenAt: agents.lastSeenAt,
        createdAt: agents.createdAt,
        printerCount: count(printers.id),
      })
      .from(agents)
      .where(eq(agents.tenantId, claims.tenantId))
      .leftJoin(printers, and(eq(printers.agentId, agents.id), eq(printers.tenantId, claims.tenantId)))
      .groupBy(agents.id)
      .orderBy(desc(agents.createdAt));
    allPrinters = await db.select().from(printers).where(eq(printers.tenantId, claims.tenantId)).orderBy(desc(printers.createdAt));
    // Metadata-only projection: `payload` (base64 document bytes, up to ~5 MB
    // per job) must never ride along in the 50-row list. Full payloads are
    // fetched per-job on demand by the inspector via GET /api/jobs/[id].
    const jobColumns = {
      id: printJobs.id,
      tenantId: printJobs.tenantId,
      destination: printJobs.destination,
      documentType: printJobs.documentType,
      agentId: printJobs.agentId,
      printerId: printJobs.printerId,
      status: printJobs.status,
      error: printJobs.error,
      requestedBy: printJobs.requestedBy,
      retries: printJobs.retries,
      deliveryAttempts: printJobs.deliveryAttempts,
      claimedAt: printJobs.claimedAt,
      deliveredAt: printJobs.deliveredAt,
      ackedAt: printJobs.ackedAt,
      expiresAt: printJobs.expiresAt,
      createdAt: printJobs.createdAt,
      updatedAt: printJobs.updatedAt,
    } as const;
    allJobs = await db
      .select(jobColumns)
      .from(printJobs)
      .where(eq(printJobs.tenantId, claims.tenantId))
      .orderBy(desc(printJobs.createdAt))
      .limit(50);
  } catch (error: unknown) {
    // Dotted event name (aggregation-safe) and a string message — a live
    // Error would serialize as {} and lose the failure reason.
    logError("dashboard.database_load_failed", { error: error instanceof Error ? error.message : String(error) });
    databaseError = t("dashboard.page.databaseLoadFailedLog");
  }

  const now = new Date();
  const visibleAgents = allAgents.map((agent) => ({ ...agent, status: isAgentAvailableForJob(agent, now) ? "online" : "offline" }));

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
            pulse={!databaseError}
            label={databaseError ? t("dashboard.page.dbUnavailableBadge") : t("dashboard.page.live")}
          />
        }
        actions={
          <>
            <Button variant="ghost" size="sm" href="/system-health" icon={<LifeBuoy className="h-4 w-4" />}>
              {t("dashboard.page.systemHealth")}
            </Button>
            {!databaseError ? <JobCleanupButton /> : null}
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
            initialAgents={visibleAgents}
            initialPrinters={allPrinters}
            initialJobs={allJobs}
            databaseError={null}
          />
        )}
      </PageContainer>
    </>
  );
}
