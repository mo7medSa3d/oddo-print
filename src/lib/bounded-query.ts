/**
 * Admission control for diagnostic DB reads.
 *
 * PostgreSQL statement_timeout cancels work on the server; a JS Promise.race
 * merely stops the caller waiting. Keep the admission slot held until the real
 * query settles, even if the caller has already received a timeout. Otherwise
 * successive timeouts can stampede a finite pg Pool with invisible work.
 *
 * Do not use pg's query_timeout here: Drizzle 0.45.x transaction BEGIN failures
 * need a separate upstream pool-client release fix; client-side cancellation
 * is not a safe substitute for server-side statement_timeout.
 */
export class BoundedQueryRunner {
  private outstanding = 0;

  constructor(private readonly maximumOutstanding: number) {
    if (!Number.isSafeInteger(maximumOutstanding) || maximumOutstanding < 1) {
      throw new Error("DB diagnostic concurrency limit must be a positive integer");
    }
  }

  get activeCount(): number {
    return this.outstanding;
  }

  async run<T>(query: () => Promise<T>, ms: number, label: string): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error("DB diagnostic timeout must be positive and finite");
    }
    if (this.outstanding >= this.maximumOutstanding) {
      throw new Error("DB diagnostics overloaded: outstanding queries have reached the bounded budget");
    }

    // Acquire synchronously before awaiting anything, so concurrent callers
    // cannot exceed the budget. Query may throw synchronously; .then captures it.
    this.outstanding++;
    const operation = Promise.resolve().then(query);
    // Attach both resolution handlers immediately, including for operations
    // that settle after the caller's timeout; no unhandled rejection or leak.
    void operation.then(
      () => { this.outstanding--; },
      () => { this.outstanding--; },
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DB timeout ${label} after ${ms}ms`)), ms);
        timer.unref?.();
      });
      return await Promise.race([operation, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
