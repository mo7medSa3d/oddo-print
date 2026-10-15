import { logWarn } from "./log";
import { agentStaleThresholdSeconds, printerStaleThresholdSeconds } from "./agent-availability";
import { db, pool } from "../db";
import { sql } from "drizzle-orm";
import { nonVirtualPrinterPredicate } from "./printer-virtual-sql";

type Counter = { value: number };

const localCounters = new Map<string, Counter>();

function sanitizeMetricName(name: string): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`Invalid Prometheus metric name: ${name}`);
  return name;
}

export function formatCounterLine(name: unknown, value: unknown): string | null {
  if (typeof name !== "string") return null;
  try {
    sanitizeMetricName(name);
  } catch {
    return null;
  }
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return null;
  return `${name} ${numeric}`;
}

export async function incrementMetric(name: string, value = 1): Promise<void> {
  const safeName = sanitizeMetricName(name);
  if (!Number.isInteger(value) || value <= 0) return;
  const current = localCounters.get(safeName) ?? { value: 0 };
  current.value += value;
  localCounters.set(safeName, current);

  try {
    await pool.query(`
      INSERT INTO gateway_metrics (name, value, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (name)
      DO UPDATE SET value = gateway_metrics.value + EXCLUDED.value, updated_at = now()
    `, [safeName, value]);
  } catch (error) {
    logWarn("metrics.persist_failed", { name: safeName, error });
    // Metrics must never break a print/auth/job request when the metrics table
    // is unavailable during startup, migration, or an isolated DB outage.
  }
}

async function renderFleetGauges(): Promise<string> {
  const staleSeconds = agentStaleThresholdSeconds();
  try {
    const [jobs, agents, printers] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'queued')::bigint AS queued,
          COUNT(*) FILTER (WHERE status IN ('claimed', 'printing'))::bigint AS in_flight
        FROM print_jobs
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE lifecycle = 'active' AND status = 'online' AND fresh)::bigint AS online,
          COUNT(*) FILTER (WHERE lifecycle = 'active' AND status = 'offline' AND fresh)::bigint AS offline,
          COUNT(*) FILTER (WHERE lifecycle = 'active' AND last_seen_at IS NOT NULL AND NOT fresh)::bigint AS stale,
          COUNT(*) FILTER (WHERE lifecycle = 'active' AND last_seen_at IS NULL)::bigint AS unknown
        FROM (
          SELECT lifecycle, status, last_seen_at,
            COALESCE(last_seen_at BETWEEN now() - make_interval(secs => $1) AND now(), false) AS fresh
          FROM agents
        ) observations
      `, [staleSeconds]),
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE p.lifecycle = 'active' AND p.status = 'online' AND printer_fresh)::bigint AS online,
          COUNT(*) FILTER (WHERE p.lifecycle = 'active' AND p.status = 'busy' AND printer_fresh)::bigint AS busy,
          COUNT(*) FILTER (WHERE p.lifecycle = 'active' AND p.status = 'offline' AND printer_fresh)::bigint AS offline,
          COUNT(*) FILTER (WHERE p.lifecycle = 'active' AND p.status = 'error' AND printer_fresh)::bigint AS error,
          COUNT(*) FILTER (WHERE p.lifecycle = 'active' AND p.last_seen_at IS NOT NULL AND NOT printer_fresh)::bigint AS stale,
          COUNT(*) FILTER (WHERE p.lifecycle = 'active' AND (p.last_seen_at IS NULL OR (printer_fresh AND p.status = 'unknown')))::bigint AS unknown,
          COUNT(*) FILTER (WHERE p.lifecycle = 'disabled')::bigint AS disabled,
          COUNT(*) FILTER (WHERE p.lifecycle = 'retired')::bigint AS retired,
          COUNT(*) FILTER (
            WHERE p.lifecycle = 'active'
              AND p.status IN ('online', 'busy')
              AND printer_fresh
              AND a.lifecycle = 'active'
              AND a.status = 'online'
              AND agent_fresh
          )::bigint AS routable
        FROM (
          SELECT *, COALESCE(last_seen_at BETWEEN now() - make_interval(secs => ${printerStaleThresholdSeconds()}) AND now(), false) AS printer_fresh
          FROM printers WHERE shared_with_gateway = true AND inventory_present = true
            AND ${nonVirtualPrinterPredicate()}
        ) p
        LEFT JOIN (
          SELECT *, COALESCE(last_seen_at BETWEEN now() - make_interval(secs => ${staleSeconds}) AND now(), false) AS agent_fresh
          FROM agents
        ) a ON a.id = p.agent_id AND a.tenant_id = p.tenant_id
      `),
    ]);

    const j = jobs.rows[0] as Record<string, string>;
    const a = agents.rows[0] as Record<string, string>;
    const p = printers.rows[0] as Record<string, string>;
    return [
      `# TYPE print_jobs_queue_depth gauge`,
      `print_jobs_queue_depth ${j.queued}`,
      `# TYPE print_jobs_in_flight gauge`,
      `print_jobs_in_flight ${j.in_flight}`,
      `# TYPE agents_online gauge`,
      `agents_online ${a.online}`,
      `# TYPE agents_offline gauge`,
      `agents_offline ${a.offline}`,
      `# TYPE agents_stale gauge`,
      `agents_stale ${a.stale}`,
      `# TYPE agents_unknown gauge`,
      `agents_unknown ${a.unknown}`,
      `# TYPE printers_online gauge`,
      `printers_online ${p.online}`,
      `# TYPE printers_busy gauge`,
      `printers_busy ${p.busy}`,
      `# TYPE printers_offline gauge`,
      `printers_offline ${p.offline}`,
      `# TYPE printers_error gauge`,
      `printers_error ${p.error}`,
      `# TYPE printers_stale gauge`,
      `printers_stale ${p.stale}`,
      `# TYPE printers_unknown gauge`,
      `printers_unknown ${p.unknown}`,
      `# TYPE printers_routable gauge`,
      `printers_routable ${p.routable}`,
      `# TYPE printers_disabled gauge`,
      `printers_disabled ${p.disabled}`,
      `# TYPE printers_retired gauge`,
      `printers_retired ${p.retired}`,
    ].join("\n");
  } catch (error) {
    logWarn("metrics.gauges_unavailable", { error });
    // A partial fleet-collector failure must fail the scrape. HTTP 200 with
    // absent gauge names otherwise looks healthy to Prometheus and conceals
    // growing queues / offline printers. Never expose SQL/error details.
    throw new Error("Fleet metrics collection unavailable");
  }
}

export async function renderPrometheusMetrics(): Promise<string> {
  let counterOutput = "";
  try {
    const result = await pool.query<{ name: string; value: string }>(
      "SELECT name, value::text FROM gateway_metrics ORDER BY name",
    );
    if (result.rows.length > 0) {
      const lines: string[] = [];
      for (const row of result.rows) {
        const line = formatCounterLine(row.name, row.value);
        if (line === null) {
          logWarn("metrics.counter_row_skipped", { name: typeof row.name === "string" ? row.name.slice(0, 128) : typeof row.name });
          continue;
        }
        lines.push(`# TYPE ${row.name} counter\n${line}`);
      }
      counterOutput = lines.join("\n");
    }
  } catch (error) {
    logWarn("metrics.counters_unavailable", { error });
    // Fall back to the local process counters below.
  }

  if (!counterOutput) {
    counterOutput = Array.from(localCounters.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, counter]) => `# TYPE ${name} counter\n${name} ${counter.value}`)
      .join("\n");
  }

  const gauges = await renderFleetGauges();
  const sections = [counterOutput, gauges].filter(Boolean);
  return sections.length ? `${sections.join("\n")}\n` : "";
}
