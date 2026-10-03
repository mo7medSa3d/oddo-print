/**
 * Dependency-free heartbeat-staleness thresholds.
 *
 * This module has NO imports on purpose: the staleness policy is needed by
 * client-bundled code (`src/shared/job-vocabulary.ts`, consumed by the
 * dashboard and the Tauri desktop Vite build) as well as by the server.
 * Importing it from `agent-availability.ts` would drag the `db` → `pg`
 * chain (via `database-clock.ts`) into browser/desktop bundles and break
 * those builds. Server code should keep importing the canonical
 * `agent-availability.ts` API (which re-exports everything here); shared
 * UI code must import from this module. Do not add imports to this file.
 */
export const DEFAULT_AGENT_STALE_THRESHOLD_SECONDS = 90;
export const DEFAULT_PRINTER_STALE_THRESHOLD_SECONDS = 90;

/**
 * Floor for `STALE_AGENT_THRESHOLD_SECONDS`.
 *
 * This value is ONE HALF OF A CROSS-SYSTEM CONTRACT, not a free tuning knob.
 * The Go Agent hardcodes `staleClaimSafetyWindow = 90 * time.Second`
 * (`agent/internal/agent/agent.go`) and uses it to prove ownership when the
 * `claimed -> printing` report fails as a transport error rather than being
 * explicitly rejected: `authorizeDispatchAfterReportFailure` allows physical
 * dispatch only while `now - receivedAt < 90s`, on the reasoning that no
 * reclaim could have completed inside that window.
 *
 * That reasoning holds only if the Gateway cannot reclaim sooner. The requeue
 * sweep (`src/lib/job-maintenance.ts`) uses `agentStaleThresholdSeconds()` as
 * the lease, so a configured value BELOW 90 invalidates the Agent's proof
 * during [threshold, 90): the Gateway may already have requeued and reassigned
 * a job the Agent still believes it owns, and the Agent would dispatch it to
 * hardware a second time. That is a duplicate physical print, which is the one
 * outcome this architecture exists to prevent.
 *
 * The floor is therefore 90 — not a smaller heartbeat-derived number. It also
 * happens to satisfy the presence constraint (the Agent heartbeats every 30s
 * and budgets 15s per attempt, so anything under ~45s would declare a healthy
 * agent stale), but the lease contract is the binding constraint.
 *
 * Out-of-range values fall back to the default rather than being clamped
 * silently, matching the pre-existing behaviour.
 *
 * The Agent cannot read this value today, so this floor is what keeps the two
 * sides safe. `tests/stale-threshold.test.ts` parses the Agent's constant out
 * of the Go source and fails if the floor ever drops below it.
 */
export const MIN_AGENT_STALE_THRESHOLD_SECONDS = 90;
export const MAX_AGENT_STALE_THRESHOLD_SECONDS = 3600;

export function agentStaleThresholdSeconds(): number {
  const raw = Number(process.env.STALE_AGENT_THRESHOLD_SECONDS ?? DEFAULT_AGENT_STALE_THRESHOLD_SECONDS);
  if (
    !Number.isFinite(raw) ||
    raw < MIN_AGENT_STALE_THRESHOLD_SECONDS ||
    raw > MAX_AGENT_STALE_THRESHOLD_SECONDS
  ) {
    return DEFAULT_AGENT_STALE_THRESHOLD_SECONDS;
  }
  return Math.floor(raw);
}

export function printerStaleThresholdSeconds(): number {
  // Keep printer execution freshness aligned with printer-health.ts's
  // evidence policy. There is intentionally no separate env override: a
  // mismatch here could make the UI say UNKNOWN while the claim gate still
  // executes the printer (or vice versa).
  return DEFAULT_PRINTER_STALE_THRESHOLD_SECONDS;
}
