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
 * The Agent heartbeats on a fixed 30s ticker and allows each heartbeat attempt
 * up to 15s (`agent/internal/agent/agent.go`). A threshold below one heartbeat
 * cycle plus one attempt timeout therefore declares a *healthy* agent stale:
 * at the old floor of 10s an agent heartbeating every 30s would read stale for
 * roughly two thirds of its life, and job claiming — which requires
 * `last_seen_at >= now() - threshold` — would almost never succeed.
 *
 * 60s tolerates a full missed cycle (30s) plus a hung attempt (15s) with
 * margin. Anything lower is not a tuning choice, it is a misconfiguration, so
 * it falls back to the default rather than being clamped silently.
 */
export const MIN_AGENT_STALE_THRESHOLD_SECONDS = 60;
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
