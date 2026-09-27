import { db, pool } from "./index";

export { db, pool };

export async function queryWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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
    const result = await Promise.race([promise, timeout]);
    return result as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
