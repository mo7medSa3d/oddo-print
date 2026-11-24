import { sql } from "drizzle-orm";
import type { DbTx } from "../db";

/** Metadata-driven, read-only database inventory. Database identifiers are
 * never supplied to SQL directly by the browser. All identifiers are quoted
 * only after checking them against information_schema.
 *
 * Sensitive columns (including credential hashes, tokens and raw print payload)
 * are excluded server-side, not masked after fetching. JSON/blob columns are
 * excluded because they may contain nested secrets or customer documents.
 */
const SECRET = /(?:password|secret|token|credential|private|signature|salt|hash|payload|document|certificate|authorization|cookie|session_data|card_number|payment_method|refresh|recovery|otp|passcode|api_key_value|body|content|address_line|phone|email)/i;
// The operator explorer is not a schema dump. Provider data is archived,
 // and pre-upgrade servers must never leak legacy billing identifiers.
const RETIRED_COLUMNS = /^(?:stripe_.+|checkout_.+|billing_operation_.+|trial_started_at|billing_mode|currency|interval)$/i;
const RETIRED_TABLES = new Set(["billing_events", "print_usage_periods"]);
const PLAN_VISIBLE = new Set(["id", "name", "description", "is_active", "is_public", "created_at", "updated_at"]);
const SAFE_TYPES = new Set(["text","character varying","character","uuid","integer","bigint","smallint","numeric","boolean","timestamp without time zone","timestamp with time zone","date","double precision","real","USER-DEFINED"]);
const ALWAYS_HIDDEN = new Set(["platform_sessions","refresh_tokens","auth_rate_limits","password_reset_tokens","email_verification_tokens","pg_stat_statements",
  "platform_session_security", "workspace_session_security"]);
export type ExploreTable = { name: string; columns: string[]; primaryKey: string | null; primaryKeys?: string[] };
const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';

export async function listExploreTables(tx: DbTx): Promise<ExploreTable[]> {
  // One bounded catalog query rather than an N+1 request per table. The
  // information_schema query itself does not read any customer row or secret.
  const catalog = await tx.execute(sql<{
    table_name: string; column_name: string; data_type: string; is_primary: boolean;
  }>`SELECT c.table_name, c.column_name, c.data_type,
        EXISTS (
          SELECT 1 FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_catalog = tc.constraint_catalog
            AND kcu.constraint_schema = tc.constraint_schema
            AND kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema = tc.table_schema
            AND kcu.table_name = tc.table_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = c.table_schema
            AND tc.table_name = c.table_name
            AND kcu.column_name = c.column_name
        ) AS is_primary
     FROM information_schema.columns c
     JOIN (
       SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
       ORDER BY table_name LIMIT 250
     ) t ON t.table_name = c.table_name
     WHERE c.table_schema = current_schema()
     ORDER BY c.table_name, c.ordinal_position`);
  const grouped = new Map<string, {
    columns: string[];
    primary: string[];
  }>();
  const catalogRows = catalog.rows as Array<{
    table_name: string; column_name: string; data_type: string; is_primary: boolean;
  }>;
  for (const column of catalogRows) {
    if (ALWAYS_HIDDEN.has(column.table_name) || RETIRED_TABLES.has(column.table_name)) continue;
    let table = grouped.get(column.table_name);
    if (!table) {
      table = { columns: [], primary: [] };
      grouped.set(column.table_name, table);
    }
    if (!SAFE_TYPES.has(column.data_type) || SECRET.test(column.column_name) || RETIRED_COLUMNS.test(column.column_name)) continue;
    if (column.table_name === "plans" && !PLAN_VISIBLE.has(column.column_name)) continue;
    if (table.columns.length >= 40) continue;
    table.columns.push(column.column_name);
    if (column.is_primary) table.primary.push(column.column_name);
  }
  return [...grouped.entries()]
    .filter(([, table]) => table.columns.length > 0)
    .map(([name, table]) => ({
      name, columns: table.columns,
      primaryKey: table.primary[0] ?? (table.columns.includes("id") ? "id" : null),
      ...(table.primary.length > 1 ? { primaryKeys: table.primary } : {}),
    }));
}
export async function exploreRows(tx: DbTx, table: ExploreTable, search: string, offset: number, limit: number) {
  const colSQL = table.columns.map(quote).join(", ");
  // Search visible scalar fields only; never fetch secrets or interpolate user input.
  // Include exact/partial ID and common human labels (names, slugs, statuses).
  const preferred = table.columns.filter(c => /^(id|tenant_id|agent_id|printer_id|name|display_name|slug|status|lifecycle|plan_id|job_id|code|external_id|domain|type|protocol)$/i.test(c)).slice(0,10);
  const searchable = preferred.length ? preferred : table.primaryKey ? [table.primaryKey] : [];
  // strpos treats punctuation, percent signs and underscores literally.
  // Bind the term: browser input NEVER becomes a SQL identifier or expression.
  const where = search && searchable.length
    ? sql`WHERE (${sql.join(searchable.map(c => sql`strpos(lower(${sql.raw(quote(c))}::text), lower(${search})) > 0`), sql` OR `)})`
    : sql``;
  if (search && !searchable.length) return [];
  // A creation timestamp is not unique, particularly for bulk inserts and
  // memberships. Include every visible primary-key column so adjacent pages
  // have a deterministic order for an unchanged dataset.
  const orderColumns = [...new Set([
    table.columns.includes("created_at") ? "created_at" : table.primaryKey ?? table.columns[0],
    ...(table.primaryKeys ?? (table.primaryKey ? [table.primaryKey] : [])),
  ])].filter(column => table.columns.includes(column));
  const result = await tx.execute(sql<Record<string,unknown>>`
    SELECT ${sql.raw(colSQL)} FROM ${sql.raw(quote(table.name))} ${where}
    ORDER BY ${sql.raw(orderColumns.map(column => `${quote(column)} DESC`).join(", "))}
    LIMIT ${limit} OFFSET ${offset}`);
  return result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,
     typeof v==="string" && v.length>320 ? v.slice(0,320)+"…" : v instanceof Date ? v.toISOString() : v])));
}
export async function readPlatformDatabase(tx: DbTx, input: { table?: string; search?: string; offset?: number }) {
  await tx.execute(sql`SET LOCAL statement_timeout = '4000ms'`);
  const tables = await listExploreTables(tx);
  const table = input.table ? tables.find(t=>t.name === input.table) : null;
  const pageSize = 25;
  const rows = table ? await exploreRows(tx,table,input.search ?? "",input.offset ?? 0,pageSize + 1) : [];
  return { tables, selected: table?.name ?? null, columns: table?.columns ?? [], rows: rows.slice(0,pageSize),
    hasMore:rows.length>pageSize };
}
