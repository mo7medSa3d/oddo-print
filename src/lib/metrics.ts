import { logWarn } from "./log";
import { pool } from "../db";

type Counter = { value: number };

const MAX_LOCAL_COUNTERS = 500;
const localCounters = new Map<string, Counter>();
let localCounterCapWarned = false;

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
  const existing = localCounters.get(safeName);
  if (existing) {
    existing.value += value;
  } else if (localCounters.size < MAX_LOCAL_COUNTERS) {
    localCounters.set(safeName, { value });
  } else if (!localCounterCapWarned) {
    localCounterCapWarned = true;
    logWarn("metrics.local_counter_cap_reached", { limit: MAX_LOCAL_COUNTERS, name: safeName });
  }

  try {
    await pool.query(`
      INSERT INTO gateway_metrics (name, value, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (name)
      DO UPDATE SET value = gateway_metrics.value + EXCLUDED.value, updated_at = now()
    `, [safeName, value]);
  } catch (error) {
    logWarn("metrics.persist_failed", { name: safeName, error });
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

  return counterOutput ? `${counterOutput}\n` : "";
}
