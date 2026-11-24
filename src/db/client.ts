import { db, pool } from "./index";
import { CircuitBreaker } from "../lib/circuit-breaker";
import { BoundedQueryRunner } from "../lib/bounded-query";
import { logWarn } from "../lib/log";

export { db, pool };

const dbCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  name: "postgresql",
});


// Diagnostic reads are best-effort. Reserve at least 12 of the 20 pooled
// connections for printing, auth and durable job state transitions. A timed-out
// read is still counted until its PostgreSQL operation ACTUALLY settles.
const boundedDiagnosticQueries = new BoundedQueryRunner(8);

export async function queryWithTimeout<T>(query: () => Promise<T>, ms: number, label: string): Promise<T> {
  try {
    return await dbCircuitBreaker.execute(() => boundedDiagnosticQueries.run(query, ms, label));
  } catch (error) {
    logWarn("pg.diagnostic_query_failed", {
      label,
      timeoutMs: ms,
      breakerState: dbCircuitBreaker.getState(),
      diagnosticActive: boundedDiagnosticQueries.activeCount,
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
