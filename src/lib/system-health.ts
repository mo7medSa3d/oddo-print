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
 *   - If Odoo/Billing are UNKNOWN/NOT VERIFIED, overall cannot be OK → UNKNOWN
 *   - This prevents green "system healthy" when unverified critical dependencies exist
 * - All critical+important healthy and external verified OK → overall OK
 * - Otherwise WARN
 */

import { db, queryWithTimeout } from "../db/client";
import { sql } from "drizzle-orm";

export type HealthState = "ok" | "warn" | "error" | "unknown";

export interface HealthCheck {
  name: string;
  state: HealthState;
  message: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
  critical?: boolean;
}

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
    await queryWithTimeout(db.execute(sql`SELECT 1`), 2000, "systemHealthDB");
    return { name: "Database", state: "ok", message: "Postgres reachable", latencyMs: Date.now() - start, critical: true };
  } catch (e) {
    return { name: "Database", state: "error", message: `DB unreachable: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start, critical: true };
  }
}

export async function checkQueue(tenantId?: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    // Tenant-safe: MUST scope by tenantId when provided, otherwise warn about cross-tenant leak
    if (!tenantId) {
      return { name: "Queue", state: "unknown", message: "Queue check requires tenant context (tenant-safe enforcement)", latencyMs: Date.now() - start, critical: false };
    }
    const result = await queryWithTimeout(
      db.execute(sql`SELECT COUNT(*)::int as stuck FROM print_jobs WHERE tenant_id=${tenantId} AND status='claimed' AND claimed_at < NOW() - INTERVAL '5 minutes'`),
      2000,
      "systemHealthQueue"
    );
    const stuck = (result.rows?.[0] as any)?.stuck ?? 0;
    if (stuck > 10) {
      return { name: "Queue", state: "warn", message: `${stuck} stuck jobs (claimed >5m) for tenant ${tenantId}`, latencyMs: Date.now() - start, details: { stuck, tenantId }, critical: false };
    }
    return { name: "Queue", state: "ok", message: `Queue healthy for tenant ${tenantId}`, latencyMs: Date.now() - start, details: { stuck, tenantId }, critical: false };
  } catch (e) {
    return { name: "Queue", state: "unknown", message: `Queue check failed: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start, critical: false };
  }
}

export async function checkAgents(tenantId?: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    if (!tenantId) {
      return { name: "Agents", state: "unknown", message: "Agents check requires tenant context", latencyMs: Date.now() - start };
    }
    const result = await queryWithTimeout(
      db.execute(sql`SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '90 seconds')::int as online FROM agents WHERE tenant_id=${tenantId}`),
      2000,
      "systemHealthAgents"
    );
    const row = result.rows?.[0] as any;
    const total = row?.total ?? 0;
    const online = row?.online ?? 0;
    if (total === 0) return { name: "Agents", state: "warn", message: `No agents registered for tenant ${tenantId}`, latencyMs: Date.now() - start, details: { total, online, tenantId } };
    if (online === 0) return { name: "Agents", state: "error", message: `${total} agents but none online for tenant ${tenantId}`, latencyMs: Date.now() - start, details: { total, online, tenantId } };
    if (online < total) return { name: "Agents", state: "warn", message: `${online}/${total} agents online for tenant ${tenantId}`, latencyMs: Date.now() - start, details: { total, online, tenantId } };
    return { name: "Agents", state: "ok", message: `${online}/${total} agents online for tenant ${tenantId}`, latencyMs: Date.now() - start, details: { total, online, tenantId } };
  } catch (e) {
    return { name: "Agents", state: "unknown", message: `Agent check failed: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start };
  }
}

export async function checkPrinters(tenantId?: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    if (!tenantId) {
      return { name: "Printers", state: "unknown", message: "Printers check requires tenant context", latencyMs: Date.now() - start };
    }
    const result = await queryWithTimeout(
      db.execute(sql`SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE status='online')::int as online FROM printers WHERE tenant_id=${tenantId}`),
      2000,
      "systemHealthPrinters"
    );
    const row = result.rows?.[0] as any;
    const total = row?.total ?? 0;
    const online = row?.online ?? 0;
    if (total === 0) return { name: "Printers", state: "warn", message: `No printers registered for tenant ${tenantId}`, latencyMs: Date.now() - start, details: { total, online, tenantId } };
    return { name: "Printers", state: online > 0 ? "ok" : "warn", message: `${online}/${total} printers online for tenant ${tenantId}`, latencyMs: Date.now() - start, details: { total, online, tenantId } };
  } catch (e) {
    return { name: "Printers", state: "unknown", message: `Printer check failed: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start };
  }
}

export function checkGateway(): HealthCheck {
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  return {
    name: "Gateway",
    state: heapUsedMb > 500 ? "warn" : "ok",
    message: `Gateway running, heap ${heapUsedMb}MB`,
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

  // External: Odoo, Billing — if UNKNOWN, overall cannot be OK
  const external = checks.filter(c => ["Odoo", "Billing"].includes(c.name));
  if (external.some(c => c.state === "unknown")) return "unknown";
  if (external.some(c => c.state === "error")) return "error";
  if (external.some(c => c.state === "warn")) return "warn";

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
  const odoo: HealthCheck = { name: "Odoo", state: "unknown", message: "Odoo health NOT VERIFIED — requires runtime check via /api/odoo/health (BLOCKED without Odoo deployment)" };
  const billing: HealthCheck = { name: "Billing", state: "unknown", message: "Billing health NOT VERIFIED — requires Stripe connectivity check (BLOCKED without Stripe config)" };

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
    version: { gateway: process.env.npm_package_version ?? "unknown", schema: 55 },
    checks,
    policy: "CRITICAL (Gateway,Database) ERROR→error, UNKNOWN→unknown; IMPORTANT (Queue,Agents,Printers) ERROR→error, UNKNOWN→unknown, WARN→warn; EXTERNAL (Odoo,Billing) UNKNOWN→unknown (prevents false OK); all healthy→ok",
  };
}
