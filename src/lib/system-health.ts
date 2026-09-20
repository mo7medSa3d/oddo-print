/**
 * System Health — single page aggregating Gateway, DB, Queue, Agents, Printers, Odoo, Billing
 * For Release Readiness Dashboard and client demo.
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
}

export async function checkDatabase(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await queryWithTimeout(db.execute(sql`SELECT 1`), 2000, "systemHealthDB");
    return { name: "Database", state: "ok", message: "Postgres reachable", latencyMs: Date.now() - start };
  } catch (e) {
    return { name: "Database", state: "error", message: `DB unreachable: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start };
  }
}

export async function checkQueue(tenantId?: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    // Count stuck jobs (claimed > 5min without ack)
    const result = await queryWithTimeout(
      db.execute(sql`SELECT COUNT(*)::int as stuck FROM print_jobs WHERE status='claimed' AND claimed_at < NOW() - INTERVAL '5 minutes'`),
      2000,
      "systemHealthQueue"
    );
    const stuck = (result.rows?.[0] as any)?.stuck ?? 0;
    if (stuck > 10) {
      return { name: "Queue", state: "warn", message: `${stuck} stuck jobs (claimed >5m)`, latencyMs: Date.now() - start, details: { stuck } };
    }
    return { name: "Queue", state: "ok", message: "Queue healthy", latencyMs: Date.now() - start, details: { stuck } };
  } catch (e) {
    return { name: "Queue", state: "unknown", message: `Queue check failed: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start };
  }
}

export async function checkAgents(tenantId?: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const result = await queryWithTimeout(
      db.execute(tenantId ? sql`SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '90 seconds')::int as online FROM agents WHERE tenant_id=${tenantId}` : sql`SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '90 seconds')::int as online FROM agents`),
      2000,
      "systemHealthAgents"
    );
    const row = result.rows?.[0] as any;
    const total = row?.total ?? 0;
    const online = row?.online ?? 0;
    if (total === 0) return { name: "Agents", state: "warn", message: "No agents registered", latencyMs: Date.now() - start, details: { total, online } };
    if (online === 0) return { name: "Agents", state: "error", message: `${total} agents but none online`, latencyMs: Date.now() - start, details: { total, online } };
    if (online < total) return { name: "Agents", state: "warn", message: `${online}/${total} agents online`, latencyMs: Date.now() - start, details: { total, online } };
    return { name: "Agents", state: "ok", message: `${online}/${total} agents online`, latencyMs: Date.now() - start, details: { total, online } };
  } catch (e) {
    return { name: "Agents", state: "unknown", message: `Agent check failed: ${String(e).slice(0, 200)}`, latencyMs: Date.now() - start };
  }
}

export async function checkPrinters(tenantId?: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const result = await queryWithTimeout(
      db.execute(tenantId ? sql`SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE status='online')::int as online FROM printers WHERE tenant_id=${tenantId}` : sql`SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE status='online')::int as online FROM printers`),
      2000,
      "systemHealthPrinters"
    );
    const row = result.rows?.[0] as any;
    const total = row?.total ?? 0;
    const online = row?.online ?? 0;
    if (total === 0) return { name: "Printers", state: "warn", message: "No printers registered", latencyMs: Date.now() - start, details: { total, online } };
    return { name: "Printers", state: online > 0 ? "ok" : "warn", message: `${online}/${total} printers online`, latencyMs: Date.now() - start, details: { total, online } };
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
  };
}

export async function getSystemHealth(tenantId?: string): Promise<SystemHealth> {
  const [database, queue, agents, printers] = await Promise.all([
    checkDatabase(),
    checkQueue(tenantId),
    checkAgents(tenantId),
    checkPrinters(tenantId),
  ]);
  const gateway = checkGateway();
  const odoo: HealthCheck = { name: "Odoo", state: "unknown", message: "Odoo health requires runtime check (see /api/odoo/health)" };
  const billing: HealthCheck = { name: "Billing", state: "unknown", message: "Billing health requires Stripe connectivity check" };

  const checks = [gateway, database, queue, agents, printers, odoo, billing];
  const overall: HealthState = checks.some(c => c.state === "error") ? "error" : checks.some(c => c.state === "warn") ? "warn" : "ok";

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
    version: { gateway: process.env.npm_package_version ?? "unknown", schema: 34 },
    checks,
  };
}
