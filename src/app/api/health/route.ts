import { db } from "../../../db";
import { sql } from "drizzle-orm";
import { logError } from "../../../lib/log";

export const dynamic = "force-dynamic";

const HEALTH_QUERY_TIMEOUT_MS = 3_000;
const HEALTH_HEADERS = { "Cache-Control": "no-store" };

/**
 * Unauthenticated liveness/readiness probe for load balancers and the
 * desktop manager. Intentionally contains no inventory, job, or agent
 * counts — those are internal and belong behind manager authentication.
 *
 * Shape is stable: `{ ok: true }` on success, `{ ok: false }` with HTTP 503
 * when the database is unreachable or times out.
 */
export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("health_check_timeout")), HEALTH_QUERY_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    return Response.json({ ok: true }, { headers: HEALTH_HEADERS });
  } catch (error) {
    logError("health.readiness_check.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ ok: false }, { status: 503, headers: HEALTH_HEADERS });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
