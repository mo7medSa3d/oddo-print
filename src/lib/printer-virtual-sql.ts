import { or, sql, type SQL } from "drizzle-orm";
import { printers } from "../db/schema";
import { SESSION_REDIRECT_TOKENS, SOFTWARE_WRITER_TOKENS, VIRTUAL_CAPABILITY_KEYS, VIRTUAL_CLASSES, VIRTUAL_PORT_MONITORS } from "./printer-virtual";

// PostgreSQL's default btrim removes only spaces; match JavaScript trim.
const trimChars = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const text = (value: SQL): SQL => sql`lower(btrim(coalesce(${value}, ''), ${trimChars}))`;
const object = (value: SQL): SQL => sql`CASE WHEN jsonb_typeof(${value}) = 'object' THEN ${value} ELSE '{}'::jsonb END`;
const field = (record: SQL, key: string): SQL => sql`(${record}) -> ${key}::text`;
const string = (value: SQL): SQL => sql`CASE WHEN jsonb_typeof(${value}) = 'string' THEN ${text(sql`(${value}) #>> '{}'`)} ELSE '' END`;
const choice = (record: SQL, first: string, second: string): SQL => sql`coalesce(nullif(${field(record, first)}, 'null'::jsonb), ${field(record, second)})`;
const patterns = (tokens: readonly string[]): SQL => sql`ARRAY[${sql.join(tokens.map((token) => sql`${`%${token.replace(/[\\%_]/g, "\\$&")}%`}`), sql`, `)}]`;
const contains = (value: SQL, tokens: readonly string[]): SQL => sql`${value} LIKE ANY (${patterns(tokens)})`;

function hardwareText(record: SQL, key: string): SQL {
  const value = field(record, key);
  const entry = string(sql`item.value`);
  // Only this printer's bounded capability array is expanded, never a fleet.
  return sql`coalesce((SELECT string_agg(${entry}, ' ' ORDER BY item.ord)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END)
      WITH ORDINALITY AS item(value, ord)
    WHERE jsonb_typeof(item.value) = 'string' AND ${entry} <> ''), '')`;
}

/** DB counterpart of isVirtualPrinterRecord for bounded pages and fleet counts. */
export function nonVirtualPrinterPredicate(): SQL {
  const config = object(sql`${printers.config}`);
  const caps = object(sql`${printers.capabilities}`);
  const connection = text(sql`${printers.connectionType}`);
  const protocol = text(sql`${printers.protocol}`);
  const nativeQueue = sql`${connection} IN ('spooler', 'windows_spooler') OR ${protocol} IN ('spooler', 'windows_spooler')`;
  const aliases = [text(sql`${printers.name}`)];
  for (const record of [config, caps]) {
    for (const key of ["spooler_name", "spoolerName", "display_name", "displayName"]) aliases.push(string(field(record, key)));
  }
  aliases.push(sql`CASE WHEN ${nativeQueue} THEN ${string(field(config, "address"))} ELSE '' END`);
  const names = sql`ARRAY[${sql.join(aliases, sql`, `)}]`;
  const driverFields = ["driver_name", "driverName", "comment", "device_id", "deviceId"].map((key) => string(field(caps, key)));
  const hardwareFields = ["hardware_ids", "hardwareIds", "compatible_ids", "compatibleIds"].map((key) => hardwareText(caps, key));
  const hay = sql`concat_ws(' ', ${sql.join([...driverFields, ...hardwareFields].map((value) => sql`nullif(${value}, '')`), sql`, `)})`;
  const port = string(choice(caps, "port_name", "portName"));
  const portHead = sql`btrim(split_part(${port}, ',', 1), ${trimChars})`;
  const virtualPort = or(...VIRTUAL_PORT_MONITORS.map((monitor) => sql`${portHead} LIKE ${`${monitor}%`}`));
  const vendorFax = (value: SQL) => sql`${value} = 'fax' OR ${value} LIKE ANY (ARRAY['% fax', '%-fax', '% (fax)'])`;
  const forbidden: SQL[] = [
    sql`${text(sql`${printers.printerType}`)} IN ('virtual', 'redirected')`,
    sql`${connection} = 'virtual' OR ${protocol} = 'virtual'`,
    sql`${config} ? 'virtual_test_sink' OR ${config} ? 'virtual_spooler_test' OR ${caps} ? 'virtual_test_sink' OR ${caps} ? 'virtual_spooler_test'`,
    sql`${string(choice(caps, "printer_class", "printerClass"))} IN (${sql.join([...VIRTUAL_CLASSES].map((klass) => sql`${klass}`), sql`, `)})`,
    sql`(${virtualPort})`,
    sql`EXISTS (SELECT 1 FROM unnest(${names}) AS alias(name)
      WHERE alias.name LIKE '%(redirected%' OR alias.name LIKE '%redirected)' OR alias.name LIKE '% in session %' OR alias.name LIKE '% in session'
        OR (alias.name LIKE '%(from %' AND alias.name LIKE '%in session%')
        OR ${vendorFax(sql`alias.name`)} OR ${contains(sql`alias.name`, SOFTWARE_WRITER_TOKENS)})`,
    ...["driver_name", "driverName"].map((key) => sql`(${vendorFax(string(field(caps, key)))})`),
    contains(hay, SOFTWARE_WRITER_TOKENS),
    contains(hay, SESSION_REDIRECT_TOKENS),
  ];
  for (const key of VIRTUAL_CAPABILITY_KEYS) {
    const value = field(caps, key);
    forbidden.push(sql`coalesce(${value} = 'true'::jsonb, false) OR ${string(value)} = 'true'`);
  }
  return sql`NOT (${or(...forbidden)})`;
}
