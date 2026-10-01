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

export function agentStaleThresholdSeconds(): number {
  const raw = Number(process.env.STALE_AGENT_THRESHOLD_SECONDS ?? DEFAULT_AGENT_STALE_THRESHOLD_SECONDS);
  if (!Number.isFinite(raw) || raw < 10 || raw > 3600) return DEFAULT_AGENT_STALE_THRESHOLD_SECONDS;
  return Math.floor(raw);
}

export function printerStaleThresholdSeconds(): number {
  // Keep printer execution freshness aligned with printer-health.ts's
  // evidence policy. There is intentionally no separate env override: a
  // mismatch here could make the UI say UNKNOWN while the claim gate still
  // executes the printer (or vice versa).
  return DEFAULT_PRINTER_STALE_THRESHOLD_SECONDS;
}
