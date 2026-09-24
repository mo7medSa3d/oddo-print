import { sql } from "drizzle-orm";
import { db } from "../db";
import { agentStaleThresholdSeconds } from "./agent-availability";

export const AGENT_PRESENCE_SWEEP_INTERVAL_MS = 15_000;

/**
 * Persist stale online agents as offline. Availability remains derived from
 * lastSeenAt at request time, but this sweep makes the database converge so
 * API consumers, operators and subsequent workers do not retain an old
 * online flag forever. Historical jobs are deliberately untouched.
 */
export async function sweepStaleAgentPresence(): Promise<number> {
  const thresholdSeconds = agentStaleThresholdSeconds();
  const result = await db.execute(sql`
    UPDATE agents
       SET status = 'offline', updated_at = now()
     WHERE lifecycle = 'active'
       AND status = 'online'
       AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => ${thresholdSeconds}))
    RETURNING id
  `);
  return result.rows.length;
}
