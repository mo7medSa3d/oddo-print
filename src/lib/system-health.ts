/**
 * System Health — single page aggregating Gateway, DB, Queue, Agents, Printers, Odoo, Billing
 * For Release Readiness Dashboard and client demo.
 *
 * Tenant safety: ALL tenant-specific queries MUST include authenticated tenantId.
 * No tenant user may learn aggregate operational info belonging to another tenant.
 *
 * Overall health policy (explicit):
 * - Critical dependencies: Gateway, Database
 *   - If any critical is ERROR → overall ERROR
 *   - If any critical is UNKNOWN → overall UNKNOWN (not OK)
 * - Important dependencies: Queue, Agents, Printers
 *   - If any important is ERROR → overall ERROR
 *   - If any important is UNKNOWN → overall UNKNOWN
 *   - If any important is WARN → overall WARN (unless already ERROR/UNKNOWN)
 * - External dependencies: Odoo, Billing
 *   - Odoo/Billing are intentionally NOT runtime-checked in this endpoint (no
 *     live Odoo deployment or Stripe credentials are available to the Gateway
 *     process), so they are reported UNKNOWN / NOT VERIFIED.
 *   - Intentionally-unverified externals cap overall at WARN, never OK: the
 *     dashboard shows "degraded" rather than "healthy" while an external
 *     integration is unverified, but a missing optional external does not
 *     turn the whole system gray UNKNOWN.
 * - All critical+important healthy → overall OK
 * - Otherwise WARN
 */

import { db, queryWithTimeout } from "../db/client";
import { sql } from "drizzle-orm";
import migrationJournal from "../../drizzle/meta/_journal.json";
import { agentStaleThresholdSeconds, printerStaleThresholdSeconds } from "./stale-threshold";
import { agents, printers } from "../db/schema";

export type HealthState = "ok" | "warn" | "error" | "unknown";

export interface HealthCheck {
  name: string;
  state: HealthState;
  message: string;
  /**
   * Translation key for the detail line. Raw exception text and internal ids
   * used to be interpolated straight into `message`, which put log output on
   * an operator-facing card; they now belong in `details`.
   */
  messageKey?: string;
  messageVars?: Record<string, string | number>;
  latencyMs?: number;
  details?: Record<string, unknown>;
  critical?: boolean;
}

export const CURRENT_SCHEMA_VERSION = Number(migrationJournal.entries.at(-1)?.tag?.slice(0, 4) ?? 0);

export interface SystemHealth {
  overall: HealthState;
  timestamp: string;
  gateway: HealthCheck;
  database: HealthCheck;
  queue: HealthCheck;
  agents: HealthCheck;
  printers: HealthCheck;
  odoo: HealthCheck;
  billing: HealthCheck;
  version: { gateway: string; schema: number };
  checks: HealthCheck[];
  policy: string;
}

export async function checkDatabase(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await queryWithTimeout(() => db.execute(sql`SELECT 1`), 2000, "systemHealthDB");
    return { name: "Database", state: "ok", messageKey: "health.dbOk", message: "Postgres reachable", latencyMs: Date.now() - start, critical: true };
  } catch (e) {
    return { name: "Database", state: "error", messageKey: "health.dbUnreachable", message: `DB unreachable: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start, critical: true };
  }
}

export async function checkQueue(tenantId?: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    // Tenant-safe: MUST scope by tenantId when provided, otherwise warn about cross-tenant leak
    if (!tenantId) {
      return { name: "Queue", state: "unknown", messageKey: "health.queueNeedsTenant", message: "Queue check requires tenant context", latencyMs: Date.now() - start, critical: false };
    }
    const result = await queryWithTimeout(
      () => db.execute(sql`SELECT COUNT(*)::int as stuck FROM print_jobs WHERE tenant_id=${tenantId} AND status='claimed' AND claimed_at < NOW() - INTERVAL '5 minutes'`),
      2000,
      "systemHealthQueue"
    );
    const stuck = Number((result.rows?.[0] as { stuck?: number | string } | undefined)?.stuck ?? 0);
    if (stuck > 10) {
      return { name: "Queue", state: "warn", messageKey: "health.queueStuck", messageVars: { count: stuck }, message: `${stuck} stuck jobs (claimed >5m)`, latencyMs: Date.now() - start, details: { stuck, tenantId }, critical: false };
    }
    return { name: "Queue", state: "ok", messageKey: "health.queueOk", message: "Queue healthy", latencyMs: Date.now() - start, details: { stuck, tenantId }, critical: false };
  } catch (e) {
    return { name: "Queue", state: "unknown", messageKey: "health.queueFailed", message: `Queue check failed: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start, critical: false };
  }
}

export async function checkAgents(tenantId?: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    if (!tenantId) {
      return { name: "Agents", state: "unknown", messageKey: "health.agentsNeedsTenant", message: "Agents check requires tenant context", latencyMs: Date.now() - start };
    }
    // Freshness uses the shared claim-gate threshold (not a hardcoded
    // interval) so the display can never diverge from enforcement when
    // STALE_AGENT_THRESHOLD_SECONDS is configured.
    const staleSeconds = agentStaleThresholdSeconds();
    const result = await queryWithTimeout(
      () => db.execute(sql`SELECT COUNT(*) FILTER (WHERE lifecycle = 'active')::int as total, COUNT(*) FILTER (WHERE lifecycle = 'active' AND status = 'online' AND last_seen_at IS NOT NULL AND last_seen_at <= NOW() AND last_seen_at >= NOW() - make_interval(secs => ${agentStaleThresholdSeconds()}))::int as online FROM agents WHERE tenant_id=${tenantId}`),
      2000,
      "systemHealthAgents"
    );
    const row = result.rows?.[0] as { total?: number | string; online?: number | string } | undefined;
    const total = Number(row?.total ?? 0);
    const online = Number(row?.online ?? 0);
    if (total === 0) return { name: "Agents", state: "warn", messageKey: "health.agentsNone", message: "No agents registered", latencyMs: Date.now() - start, details: { total, online, tenantId } };
    if (online === 0) return { name: "Agents", state: "error", messageKey: "health.agentsNoneOnline", messageVars: { total }, message: `${total} agents but none online`, latencyMs: Date.now() - start, details: { total, online, tenantId } };
    if (online < total) return { name: "Agents", state: "warn", messageKey: "health.agentsPartial", messageVars: { online, total }, message: `${online}/${total} agents online`, latencyMs: Date.now() - start, details: { total, online, tenantId } };
    return { name: "Agents", state: "ok", messageKey: "health.agentsPartial", messageVars: { online, total }, message: `${online}/${total} agents online`, latencyMs: Date.now() - start, details: { total, online, tenantId } };
  } catch (e) {
    return { name: "Agents", state: "unknown", messageKey: "health.agentsFailed", message: `Agent check failed: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start };
  }
}

export async function checkPrinters(tenantId?: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    if (!tenantId) {
      return { name: "Printers", state: "unknown", messageKey: "health.printersNeedsTenant", message: "Printers check requires tenant context", latencyMs: Date.now() - start };
    }
    const result = await queryWithTimeout(
      () => db.execute(sql`SELECT COUNT(*) FILTER (WHERE p.lifecycle = 'active')::int as total, COUNT(*) FILTER (WHERE p.lifecycle = 'active' AND p.status IN ('online','busy') AND p.last_seen_at IS NOT NULL AND p.last_seen_at <= NOW() AND p.last_seen_at >= NOW() - make_interval(secs => ${printerStaleThresholdSeconds()}) AND a.lifecycle = 'active' AND a.status = 'online' AND a.last_seen_at IS NOT NULL AND a.last_seen_at <= NOW() AND a.last_seen_at >= NOW() - make_interval(secs => ${agentStaleThresholdSeconds()}))::int as online FROM printers p LEFT JOIN agents a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id WHERE p.tenant_id=${tenantId}`),
      2000,
      "systemHealthPrinters"
    );
    const row = result.rows?.[0] as { total?: number | string; online?: number | string } | undefined;
    const total = Number(row?.total ?? 0);
    const online = Number(row?.online ?? 0);
    if (total === 0) return { name: "Printers", state: "warn", messageKey: "health.printersNone", message: "No printers registered", latencyMs: Date.now() - start, details: { total, online, tenantId } };
    return { name: "Printers", state: online > 0 ? "ok" : "warn", messageKey: "health.printersOnline", messageVars: { online, total }, message: `${online}/${total} printers online`, latencyMs: Date.now() - start, details: { total, online, tenantId } };
  } catch (e) {
    return { name: "Printers", state: "unknown", messageKey: "health.printersFailed", message: `Printer check failed: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start };
  }
}

export function checkGateway(): HealthCheck {
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  return {
    name: "Gateway",
    state: heapUsedMb > 500 ? "warn" : "ok",
    messageKey: "health.gatewayRunning", messageVars: { heap: heapUsedMb }, message: `Gateway running, heap ${heapUsedMb}MB`,
    details: { heapUsedMb, uptimeSec: Math.round(process.uptime()), nodeVersion: process.version },
    critical: true,
  };
}

function computeOverall(checks: HealthCheck[]): HealthState {
  // Critical: Gateway, Database
  const critical = checks.filter(c => c.critical);
  if (critical.some(c => c.state === "error")) return "error";
  if (critical.some(c => c.state === "unknown")) return "unknown";

  // Important: Queue, Agents, Printers
  const important = checks.filter(c => ["Queue", "Agents", "Printers"].includes(c.name));
  if (important.some(c => c.state === "error")) return "error";
  if (important.some(c => c.state === "unknown")) return "unknown";
  if (important.some(c => c.state === "warn")) return "warn";

  // External: Odoo, Billing — intentionally unverified (UNKNOWN / NOT
  // VERIFIED). They cap overall at WARN, never OK (still prevents false OK),
  // so the dashboard can still report ok/warn/error for the dependencies
  // that ARE measured.
  const external = checks.filter(c => ["Odoo", "Billing"].includes(c.name));
  if (external.some(c => c.state === "error")) return "error";
  if (external.some(c => c.state === "unknown" || c.state === "warn")) return "warn";

  // Gateway check (already critical) but also check remaining
  if (checks.some(c => c.state === "error")) return "error";
  if (checks.some(c => c.state === "unknown")) return "unknown";
  if (checks.some(c => c.state === "warn")) return "warn";
  return "ok";
}

export async function getSystemHealth(tenantId?: string): Promise<SystemHealth> {
  const [database, queue, agents, printers] = await Promise.all([
    checkDatabase(),
    checkQueue(tenantId),
    checkAgents(tenantId),
    checkPrinters(tenantId),
  ]);
  const gateway = checkGateway();
  // Honest: Odoo and Billing are NOT runtime-checked in this endpoint, so UNKNOWN
  const odoo: HealthCheck = { name: "Odoo", state: "unknown", messageKey: "health.odooNotVerified", message: "Odoo health NOT VERIFIED" };
  const billing: HealthCheck = { name: "Billing", state: "unknown", messageKey: "health.billingNotVerified", message: "Billing health NOT VERIFIED" };

  const checks = [gateway, database, queue, agents, printers, odoo, billing];
  const overall = computeOverall(checks);

  return {
    overall,
    timestamp: new Date().toISOString(),
    gateway,
    database,
    queue,
    agents,
    printers,
    odoo,
    billing,
    version: { gateway: process.env.npm_package_version ?? "1.0.0", schema: CURRENT_SCHEMA_VERSION },
    checks,
    policy: "CRITICAL (Gateway,Database) ERROR→error, UNKNOWN→unknown; IMPORTANT (Queue,Agents,Printers) ERROR→error, UNKNOWN→unknown, WARN→warn; EXTERNAL (Odoo,Billing) ERROR→error, UNKNOWN/WARN→warn (intentionally unverified externals cap overall at WARN, never OK); all healthy→ok",
  };
}
