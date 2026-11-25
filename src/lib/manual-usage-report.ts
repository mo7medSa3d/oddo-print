import { sql } from "drizzle-orm";
import type { DbTx } from "../db";

export interface LogicalUsageReport {
  jobs24h: { total: number; success: number; failed: number; queued: number };
  allTime: { total: number };
}

type UsageRow = {
  total24h: number;
  success24h: number;
  failed24h: number;
  queued24h: number;
  allTime: number;
};

const ZERO_ROW: UsageRow = { total24h: 0, success24h: 0, failed24h: 0, queued24h: 0, allTime: 0 };

/**
 * Platform-wide (tenantId=null) or per-tenant logical usage snapshot.
 * Always runs inside the caller's transaction so the read is consistent
 * with the authority check that precedes it.
 *
 * shortcut: allTime total counts all rows; add index on created_at if slow at scale
 */
export async function logicalUsageReport(
  tenantId: string | null,
  tx: DbTx,
): Promise<LogicalUsageReport> {
  const tenantFilter = tenantId
    ? sql`AND tenant_id = ${tenantId}`
    : sql``;

  const result: { rows: UsageRow[] } = await tx.execute<UsageRow>(sql`
    SELECT
      count(*) FILTER (WHERE created_at >= now() - interval '24 hours') ::int AS "total24h",
      count(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND status = 'success') ::int AS "success24h",
      count(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND status IN ('failed','expired','unknown')) ::int AS "failed24h",
      count(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND status IN ('queued','claimed','printing')) ::int AS "queued24h",
      count(*) ::int AS "allTime"
    FROM gateway_metrics_print_jobs
    WHERE 1=1 ${tenantFilter}
  `).catch((): { rows: UsageRow[] } =>
    // gateway_metrics_print_jobs may not exist in all environments;
    // fall back to zero counts so the stats endpoint never hard-fails.
    ({ rows: [ZERO_ROW] }),
  );

  const r: UsageRow = result.rows[0] ?? ZERO_ROW;

  return {
    jobs24h: { total: r.total24h, success: r.success24h, failed: r.failed24h, queued: r.queued24h },
    allTime: { total: r.allTime },
  };
}
