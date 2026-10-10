import { sql, type SQL } from "drizzle-orm";

// Agent discovery completes in at most 30 seconds in a healthy installation,
// but a sizeable, paginated inventory may require additional upload time.
// Ten minutes without a committed report page is an abandoned session, not a
// reason to retain the unique active-agent slot indefinitely. This operation
// is invoked opportunistically when an Agent polls or a manager starts/views
// a scan; it runs under PostgreSQL row-lock arbitration with report/cancel.
export const DISCOVERY_STALE_AFTER_MINUTES = 10;

export async function expireStaleAgentDiscovery(
  execute: (query: SQL) => Promise<unknown>,
  tenantId: string,
  agentId: string,
): Promise<void> {
  await execute(sql`
    UPDATE discovery_sessions AS s
    SET status = CASE
          WHEN EXISTS (
            SELECT 1 FROM discovered_devices AS d
            WHERE d.tenant_id = s.tenant_id
              AND d.agent_id = s.agent_id
              AND d.discovery_id = s.id
          ) THEN 'partial'
          ELSE 'failed'
        END,
        completed_at = now(),
        updated_at = now(),
        stats = jsonb_set(
          s.stats,
          '{errors}',
          CASE WHEN jsonb_typeof(s.stats->'errors') = 'array'
            THEN s.stats->'errors'
            ELSE '[]'::jsonb
          END || jsonb_build_array('Discovery report abandoned: no progress for 10 minutes'),
          true
        )
    WHERE s.tenant_id = ${tenantId}
      AND s.agent_id = ${agentId}
      AND s.status = 'running'
      AND s.updated_at < now() - interval '10 minutes'
  `);
}
