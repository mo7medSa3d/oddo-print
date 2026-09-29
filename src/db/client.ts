import { db, pool } from "./index";
import { CircuitBreaker } from "../lib/circuit-breaker";

export { db, pool };

const dbCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  name: "postgresql",
});

export async function queryWithTimeout<T>(query: () => Promise<T>, ms: number, label: string): Promise<T> {
  return dbCircuitBreaker.execute(async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DB timeout ${label} after ${ms}ms`)), ms);
        // Do not keep the event loop alive for an abandoned query probe.
        if (typeof timer.unref === "function") timer.unref();
      });
      // NOTE: the timeout abandons the caller-side wait but does NOT abort the
      // underlying query — it keeps running on the pooled connection until the
      // database finishes or statement_timeout fires. Callers must not assume
      // cancellation, only bounded waiting.
      const result = await Promise.race([query(), timeout]);
      return result as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}
