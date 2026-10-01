/**
 * Circuit breaker for database operations.
 *
 * Prevents cascading failures when the database is unavailable: after a
 * threshold of consecutive failures, the breaker opens and rejects calls
 * immediately without touching the network. After a cooldown period, it
 * allows a single probe (half-open); success closes the breaker, failure
 * re-opens it.
 */

export type CircuitBreakerOptions = {
  /** Consecutive failures before the breaker opens. */
  failureThreshold: number;
  /** Milliseconds the breaker stays open before allowing a probe. */
  resetTimeoutMs: number;
  /** Name for logging. */
  name: string;
};

export type CircuitBreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private failureCount = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly name: string;
  private halfOpenProbeInFlight = false;

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold;
    this.resetTimeoutMs = options.resetTimeoutMs;
    this.name = options.name;
  }

  getState(): CircuitBreakerState {
    if (this.state === "open" && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = "half-open";
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === "open") {
      throw new Error(`Circuit breaker '${this.name}' is open — database operations suspended`);
    }

    const isProbe = state === "half-open";
    if (isProbe) {
      if (this.halfOpenProbeInFlight) {
        throw new Error(`Circuit breaker '${this.name}' is half-open — recovery probe already in progress`);
      }
      // This synchronous flag acquisition is safe in Node's single-threaded
      // execution model: no await occurs between the check and assignment.
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      if (isProbe) this.halfOpenProbeInFlight = false;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}
