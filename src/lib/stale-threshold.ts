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
 * Execution lease for a job the Agent has reported as `printing`.
 *
 * The Agent's own physical-print budget is 2 minutes plus 30 seconds per
 * megabyte, capped by the 5 MiB payload limit, so a legitimate job cannot
 * exceed roughly 4.5 minutes. The 10-minute default therefore already sits
 * above the Agent's hard cap, and it is kept as the default so an existing
 * deployment keeps its current recovery behaviour. Deployments whose
 * printers are genuinely slower than the Agent's budget (for example a
 * large raster on a 9600-baud thermal) can raise it explicitly.
 */
const DEFAULT_STALE_PRINTING_SECONDS = 600;
const MIN_STALE_PRINTING_SECONDS = 120;
const MAX_STALE_PRINTING_SECONDS = 3600;

export function resolveStalePrintingSeconds(value: unknown): number {
  const raw = Number(value ?? DEFAULT_STALE_PRINTING_SECONDS);
  if (
    !Number.isFinite(raw) ||
    raw < MIN_STALE_PRINTING_SECONDS ||
    raw > MAX_STALE_PRINTING_SECONDS
  ) {
    return DEFAULT_STALE_PRINTING_SECONDS;
  }
  return Math.floor(raw);
}

export function stalePrintingSeconds(): number {
  // Server-only helper; this module is also bundled for the browser, so the
  // environment is consulted only when it actually exists.
  const configured = typeof process !== "undefined"
    ? process.env.STALE_PRINTING_SECONDS
    : undefined;
  return resolveStalePrintingSeconds(configured);
}

/**
 * Floor for `STALE_AGENT_THRESHOLD_SECONDS`.
 *
 * Keep the 90-second operational floor above the 30-second heartbeat cycle
 * plus its 15-second request budget. Out-of-range values use the default.
 * The Agent's staleClaimSafetyWindow now describes diagnostic receipt age;
 * it never authorizes physical output after a failed printing transition.
 * A delayed frame can already belong to a superseded claim regardless of its
 * local receipt age. Requiring Gateway acknowledgement prevents a duplicate physical print.
 */
export const MIN_AGENT_STALE_THRESHOLD_SECONDS = 90;
export const MAX_AGENT_STALE_THRESHOLD_SECONDS = 3600;

export function resolveAgentStaleThresholdSeconds(value: unknown): number {
  const raw = Number(value ?? DEFAULT_AGENT_STALE_THRESHOLD_SECONDS);
  if (
    !Number.isFinite(raw) ||
    raw < MIN_AGENT_STALE_THRESHOLD_SECONDS ||
    raw > MAX_AGENT_STALE_THRESHOLD_SECONDS
  ) {
    return DEFAULT_AGENT_STALE_THRESHOLD_SECONDS;
  }
  return Math.floor(raw);
}

export function agentStaleThresholdSeconds(): number {
  // This module is deliberately imported by browser/Tauri bundles. Vite does
  // not provide Node's `process` global to application source, so only consult
  // the server environment when it actually exists. Client consumers receive
  // the authoritative configured threshold through Gateway response fields and
  // pass it to resolveAgentStaleThresholdSeconds().
  const configured = typeof process !== "undefined"
    ? process.env.STALE_AGENT_THRESHOLD_SECONDS
    : undefined;
  return resolveAgentStaleThresholdSeconds(configured);
}

export function printerStaleThresholdSeconds(): number {
  // Keep printer execution freshness aligned with printer-health.ts's
  // evidence policy. There is intentionally no separate env override: a
  // mismatch here could make the UI say UNKNOWN while the claim gate still
  // executes the printer (or vice versa).
  return DEFAULT_PRINTER_STALE_THRESHOLD_SECONDS;
}
