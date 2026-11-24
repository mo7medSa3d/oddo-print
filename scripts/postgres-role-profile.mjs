#!/usr/bin/env node
/** Dedicated Gateway PostgreSQL cluster role profile. No row data is changed.
 * apply: bootstrap credentials + two independent file-backed role passwords.
 * rollback: restore the recorded ownership/ACL state; newly created roles are
 * disabled, never promoted. State files contain metadata only, mode 0600.
 * verify-runtime: run with the runtime credential before starting Gateway.
 */
import { randomBytes, pbkdf2Sync, createHmac, createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const ident = value => `"${String(value).replaceAll('"', '""')}"`;
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const roleName = value => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value ?? "") || value.startsWith("pg_")) throw new Error("Invalid profile role/database identifier");
  return value;
};
function secret(environment, name) {
  const file = environment[`${name}_FILE`];
  let value;
  try { value = file ? fs.readFileSync(file, "utf8").trim() : environment[name]?.trim(); }
  catch { throw new Error(`Cannot read configured ${name} file`); }
  if (!value || value.length < 32 || /^(?:changeme|replace|example|<)/i.test(value)) throw new Error(`${name} requires an independent generated secret of at least 32 characters`);
  return value;
}
export function profileConfiguration(environment = process.env) {
  const database = roleName(environment.PGDATABASE);
  const bootstrap = roleName(environment.PGUSER);
  const owner = roleName(environment.POSTGRES_OWNER_USER ?? "yaseir_owner");
  const runtime = roleName(environment.POSTGRES_RUNTIME_USER ?? "yaseir_runtime");
  if (new Set([bootstrap, owner, runtime]).size !== 3) throw new Error("Bootstrap, owner and runtime roles must be distinct");
  if (environment.YASEIR_DB_PROFILE_CONFIRM !== database) throw new Error("YASEIR_DB_PROFILE_CONFIRM must exactly match PGDATABASE");
  if (!environment.PGHOST || !/^\d+$/.test(environment.PGPORT ?? "5432") || +environment.PGPORT < 1 || +environment.PGPORT > 65535) throw new Error("Explicit valid PostgreSQL host/port required");
  const password = secret(environment, "PGPASSWORD");
  const ownerPassword = secret(environment, "POSTGRES_OWNER_PASSWORD");
  const runtimePassword = secret(environment, "POSTGRES_RUNTIME_PASSWORD");
  if (new Set([password, ownerPassword, runtimePassword]).size !== 3) throw new Error("Database role passwords must be independent");
  return { database, bootstrap, owner, runtime, password, ownerPassword, runtimePassword,
    host: environment.PGHOST, port: +(environment.PGPORT ?? 5432) };
}
function verifier(password) {
  const salt = randomBytes(18), salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const stored = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest("base64");
  const server = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
}
function passwordMatches(encoded, password) {
  const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):/.exec(encoded ?? "");
  if (!match || +match[1] < 4096 || +match[1] > 1000000) return false;
  const salted = pbkdf2Sync(password, Buffer.from(match[2], "base64"), +match[1], 32, "sha256");
  const stored = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest();
  const expected = Buffer.from(match[3], "base64");
  return expected.length === stored.length && timingSafeEqual(expected, stored);
}
const marker = (config, kind) => `Yaseir role profile v1 ${kind} ${config.database}`;
const objectSql = row => `${row.kind} ${row.name}`;
const privilegeKind = row => row.kind === "SEQUENCE" ? "SEQUENCE" : ["TABLE", "VIEW", "MATERIALIZED VIEW", "FOREIGN TABLE"].includes(row.kind) ? "TABLE" : row.kind;
const grantObject = row => `${privilegeKind(row)} ${row.name}`;

async function identity(client) {
  const row = (await client.query("SELECT current_database() AS database, d.oid, (pg_control_system()).system_identifier::text AS cluster FROM pg_database d WHERE d.datname=current_database()")).rows[0];
  return { database: row.database, oid: row.oid, cluster: row.cluster };
}
async function objects(client) {
  return (await client.query(`
    SELECT 'DATABASE' AS kind, quote_ident(datname) AS name, pg_get_userbyid(datdba) AS owner, datacl::text AS acl, 'd' AS aclkind, datdba AS owneroid FROM pg_database WHERE datname IN (current_database(),'postgres','template1')
    UNION ALL SELECT 'SCHEMA',quote_ident(nspname),pg_get_userbyid(nspowner),nspacl::text,'n',nspowner FROM pg_namespace WHERE nspname IN ('public','drizzle','legacy_billing','legacy_printing')
    UNION ALL SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      format('%I.%I',n.nspname,c.relname),pg_get_userbyid(c.relowner),c.relacl::text,CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END,c.relowner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle','legacy_billing','legacy_printing') AND c.relkind IN ('r','p','S','v','m','f')
    UNION ALL SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,p.oid::regprocedure::text,pg_get_userbyid(p.proowner),p.proacl::text,'f',p.proowner
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle','legacy_billing','legacy_printing') AND p.prokind IN ('f','p')
    ORDER BY kind,name
  `)).rows;
}
async function aclGrants(client, row, runtime) {
  return (await client.query("SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable FROM aclexplode(NULLIF(COALESCE($1::aclitem[],acldefault($2::\"char\",$3::oid)),'{}'::aclitem[])) a WHERE a.grantee=0 OR pg_get_userbyid(a.grantee)=$4", [row.acl, row.aclkind, row.owneroid, runtime])).rows;
}
async function defaultGrants(client, config) {
  const rows = [];
  for (const schema of [null, "public", "drizzle"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
    const code = { TABLES: "r", SEQUENCES: "S", FUNCTIONS: "f" }[kind];
    const owner = (await client.query("SELECT oid FROM pg_roles WHERE rolname=$1", [config.owner])).rows[0];
    let grants = [];
    if (owner) {
      grants = (await client.query(`SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee,
          a.privilege_type AS privilege,a.is_grantable AS grantable
        FROM aclexplode(NULLIF(COALESCE((SELECT defaclacl FROM pg_default_acl WHERE defaclrole=$1 AND defaclobjtype=$2
          AND (($3::text IS NULL AND defaclnamespace=0) OR defaclnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$3))),
          CASE WHEN $3::text IS NULL THEN acldefault(lower($2::text)::"char",$1::oid) ELSE NULL::aclitem[] END),'{}'::aclitem[])) a
        WHERE a.grantee=0 OR pg_get_userbyid(a.grantee)=$4`, [owner.oid, code, schema, config.runtime])).rows;
    } else if (kind === "FUNCTIONS" && schema === null) grants = [{ grantee: "PUBLIC", privilege: "EXECUTE", grantable: false }];
    rows.push({ kind, schema, grants });
  }
  return rows;
}
async function checkDedicatedCluster(client, config) {
  const me = (await client.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
  if (!me?.rolsuper) throw new Error("Role-profile apply requires the dedicated bootstrap administrator");
  const otherDatabases = (await client.query("SELECT datname FROM pg_database WHERE datname<>ALL($1::text[])", [[config.database, "postgres", "template0", "template1"]])).rows;
  const otherRoles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ESCAPE '\\' AND rolname<>ALL($1::text[])", [[config.bootstrap, config.owner, config.runtime]])).rows;
  if (otherDatabases.length || otherRoles.length) throw new Error("Dedicated cluster required; unrelated databases or roles need an operator-reviewed external role profile");
  const otherSchemas = (await client.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND nspname<>ALL($1::text[])", [["public", "drizzle", "information_schema", "legacy_billing", "legacy_printing"]])).rows;
  if (otherSchemas.length) throw new Error("Unexpected application schema; refusing ownership changes");
  const active = (await client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].n;
  if (active) throw new Error("Stop Gateway, migration and other target-database clients before applying or rolling back role privileges");
  const unsafeFunctions = (await client.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle','legacy_billing','legacy_printing') AND (p.prosecdef OR p.prokind NOT IN ('f','p'))")).rows[0].n;
  if (unsafeFunctions) throw new Error("Security-definer or unsupported routines require explicit privilege review");
  const customTypes = (await client.query("SELECT count(*)::int n FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('public','drizzle','legacy_billing','legacy_printing') AND t.typtype IN ('e','d','r')")).rows[0].n;
  if (customTypes) throw new Error("Custom type ownership requires explicit privilege review");
}

export async function applyProfile(client, config, stateDirectory) {
  await client.query("BEGIN");
  let stateFile;
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || ':role-profile'))");
    await checkDedicatedCluster(client, config);
    const beforeObjects = await objects(client);
    for (const row of beforeObjects) {
      if (![config.bootstrap, config.owner, "pg_database_owner"].includes(row.owner)) throw new Error("Unexpected database object owner; refusing implicit reassignment");
      row.grants = await aclGrants(client, row, config.runtime);
    }
    const state = { version: 1, createdUtc: new Date().toISOString(), identity: await identity(client),
      database: config.database, bootstrap: config.bootstrap, owner: config.owner, runtime: config.runtime,
      objects: beforeObjects, defaults: await defaultGrants(client, config), roles: {} };
    for (const [kind, name, password] of [["owner", config.owner, config.ownerPassword], ["runtime", config.runtime, config.runtimePassword]]) {
      const old = (await client.query("SELECT r.*,shobj_description(r.oid,'pg_authid') AS marker FROM pg_authid r WHERE rolname=$1", [name])).rows[0];
      state.roles[kind] = { existed: !!old, login: old?.rolcanlogin ?? false };
      if (old) {
        const memberships = (await client.query("SELECT count(*)::int n FROM pg_auth_members WHERE member=$1", [old.oid])).rows[0].n;
        if (old.marker !== marker(config, kind) || old.rolsuper || old.rolinherit || old.rolcreatedb || old.rolcreaterole || old.rolreplication || old.rolbypassrls || memberships || !passwordMatches(old.rolpassword, password)) throw new Error("Existing role does not match this profile or its configured credential; no role privileges were broadened");
        await client.query(`ALTER ROLE ${ident(name)} LOGIN NOINHERIT`);
      } else {
        await client.query(`CREATE ROLE ${ident(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(verifier(password))}`);
        await client.query(`COMMENT ON ROLE ${ident(name)} IS ${literal(marker(config, kind))}`);
      }
    }
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    stateFile = path.join(stateDirectory, `role-profile-${Date.now()}-${randomBytes(4).toString("hex")}.json`);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await client.query(`ALTER DATABASE ${ident(config.database)} OWNER TO ${ident(config.owner)}`);
    for (const database of [config.database, "postgres", "template1"]) {
      await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${ident(database)} FROM PUBLIC, ${ident(config.runtime)}`);
    }
    await client.query(`GRANT CONNECT ON DATABASE ${ident(config.database)} TO ${ident(config.runtime)}`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS public AUTHORIZATION ${ident(config.owner)}`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION ${ident(config.owner)}`);
    const currentObjects = await objects(client);
    // Table ownership also moves associated sequences; tables precede sequences.
    const order = { SCHEMA: 0, TABLE: 1, VIEW: 1, "MATERIALIZED VIEW": 1, "FOREIGN TABLE": 1, SEQUENCE: 2, FUNCTION: 3, PROCEDURE: 3 };
    for (const row of currentObjects.filter(r => r.kind !== "DATABASE").sort((a, b) => order[a.kind] - order[b.kind])) {
      await client.query(`ALTER ${objectSql(row)} OWNER TO ${ident(config.owner)}`);
      await client.query(`REVOKE ALL PRIVILEGES ON ${grantObject(row)} FROM PUBLIC, ${ident(config.runtime)}`);
    }
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ident(config.runtime)}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${ident(config.runtime)}`);
    await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(config.runtime)}`);
    for (const schema of [null, "public", "drizzle"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
      await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(config.owner)}${schema ? ` IN SCHEMA ${ident(schema)}` : ""} REVOKE ALL ON ${kind} FROM PUBLIC, ${ident(config.runtime)}`);
    }
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(config.owner)} IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${ident(config.runtime)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(config.owner)} IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${ident(config.runtime)}`);
    await client.query(fs.readFileSync(new URL("./audit-runtime-privileges.sql", import.meta.url), "utf8"));
    await client.query("COMMIT");
    return { status: "PASS", action: "apply", database: config.database, stateFile, objectsPreserved: beforeObjects.length };
  } catch (error) {
    await client.query("ROLLBACK");
    // Retain a pre-change snapshot even on rollback; it never carries passwords.
    throw error;
  }
}

export async function rollbackProfile(client, config, stateFile) {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (state.version !== 1 || ["database", "bootstrap", "owner", "runtime"].some(key => state[key] !== config[key])) throw new Error("Rollback metadata does not match the requested role profile");
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || ':role-profile'))");
    await checkDedicatedCluster(client, config);
    if (JSON.stringify(await identity(client)) !== JSON.stringify(state.identity)) throw new Error("Rollback cluster/database identity mismatch");
    for (const [kind, name] of [["owner", config.owner], ["runtime", config.runtime]]) {
      const found = (await client.query("SELECT shobj_description(oid,'pg_authid') marker FROM pg_roles WHERE rolname=$1", [name])).rows[0];
      if (found?.marker !== marker(config, kind)) throw new Error("Rollback role identity mismatch");
    }
    const current = await objects(client);
    const original = new Map(state.objects.map(row => [objectSql(row), row]));
    const originalDatabaseOwner = state.objects.find(row => row.kind === "DATABASE" && (row.name === config.database || row.name === ident(config.database)))?.owner;
    if (!originalDatabaseOwner) throw new Error("Rollback metadata omits the target database owner");
    const order = { DATABASE: 0, SCHEMA: 1, TABLE: 2, VIEW: 2, "MATERIALIZED VIEW": 2, "FOREIGN TABLE": 2, SEQUENCE: 3, FUNCTION: 4, PROCEDURE: 4 };
    for (const row of current.sort((a, b) => order[a.kind] - order[b.kind])) {
      const previous = original.get(objectSql(row));
      if (![config.owner, config.bootstrap, "pg_database_owner"].includes(row.owner)) throw new Error("Rollback found an unexpected owner");
      if (previous || row.kind !== "DATABASE") await client.query(`ALTER ${objectSql(row)} OWNER TO ${ident(previous?.owner ?? originalDatabaseOwner)}`);
      await client.query(`REVOKE ALL PRIVILEGES ON ${grantObject(row)} FROM PUBLIC, ${ident(config.runtime)}`);
      for (const grant of previous?.grants ?? []) await client.query(`GRANT ${grant.privilege} ON ${grantObject(row)} TO ${grant.grantee}${grant.grantable ? " WITH GRANT OPTION" : ""}`);
    }
    for (const item of state.defaults) {
      const prefix = `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(config.owner)}${item.schema ? ` IN SCHEMA ${ident(item.schema)}` : ""}`;
      await client.query(`${prefix} REVOKE ALL ON ${item.kind} FROM PUBLIC, ${ident(config.runtime)}`);
      for (const grant of item.grants) await client.query(`${prefix} GRANT ${grant.privilege} ON ${item.kind} TO ${grant.grantee}${grant.grantable ? " WITH GRANT OPTION" : ""}`);
    }
    for (const kind of ["owner", "runtime"]) await client.query(`ALTER ROLE ${ident(config[kind])} ${state.roles[kind].login ? "LOGIN" : "NOLOGIN"}`);
    await client.query("COMMIT");
    return { status: "PASS", action: "rollback", database: config.database, rowDataChanged: false, newlyCreatedRolesDisabled: true };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function verifyRuntime(client, expectedUser) {
  const role = (await client.query("SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
  if (role.name !== expectedUser || ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"].some(key => role[key])) throw new Error("Runtime role has forbidden cluster authority");
  const capability = (await client.query("SELECT has_database_privilege(current_database(),'CREATE') AS ddl,has_database_privilege(current_database(),'TEMP') AS temp,has_schema_privilege('public','CREATE') AS schema_create,has_schema_privilege('drizzle','USAGE') AS ledger_access,COALESCE(has_schema_privilege(to_regnamespace('legacy_billing'),'USAGE'),false) AS archive_access,COALESCE(has_schema_privilege(to_regnamespace('legacy_printing'),'USAGE'),false) AS printing_archive_access,(SELECT count(*)::int FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS memberships,(SELECT count(*)::int FROM pg_database WHERE datname<>current_database() AND datallowconn AND has_database_privilege(oid,'CONNECT')) AS other_databases")).rows[0];
  if (Object.values(capability).some(Boolean)) throw new Error("Runtime role has forbidden schema, ledger, membership or cross-database privileges");
  const objectAuthority = (await client.query(`SELECT
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','drizzle','legacy_billing','legacy_printing') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owned_relations,
    (SELECT count(*)::int FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owned_schemas,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND CASE WHEN c.relkind IN ('r','p') THEN
      (has_table_privilege(c.oid,'TRUNCATE') OR has_table_privilege(c.oid,'REFERENCES') OR has_table_privilege(c.oid,'TRIGGER')
        OR (c.relname='audit_events' AND (has_table_privilege(c.oid,'UPDATE') OR has_table_privilege(c.oid,'DELETE') OR has_any_column_privilege(c.oid,'UPDATE')))) ELSE false END) AS excess_table_privileges,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(c.oid,'UPDATE') ELSE false END) AS excess_sequence_privileges,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('legacy_billing','legacy_printing') AND CASE
        WHEN c.relkind IN ('r','p','v','m','f') THEN
          has_table_privilege(c.oid,'SELECT') OR has_table_privilege(c.oid,'INSERT') OR
          has_table_privilege(c.oid,'UPDATE') OR has_table_privilege(c.oid,'DELETE') OR
          has_table_privilege(c.oid,'TRUNCATE') OR has_table_privilege(c.oid,'REFERENCES') OR
          has_table_privilege(c.oid,'TRIGGER') OR has_any_column_privilege(c.oid,'SELECT') OR
          has_any_column_privilege(c.oid,'INSERT') OR has_any_column_privilege(c.oid,'UPDATE') OR
          has_any_column_privilege(c.oid,'REFERENCES')
        WHEN c.relkind='S' THEN has_sequence_privilege(c.oid,'USAGE') OR has_sequence_privilege(c.oid,'SELECT') OR has_sequence_privilege(c.oid,'UPDATE')
        ELSE false END) AS archived_table_access,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','drizzle','legacy_billing','legacy_printing') AND (p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        OR (p.prosecdef AND has_function_privilege(p.oid,'EXECUTE')))) AS unsafe_routines`)).rows[0];
  if (Object.values(objectAuthority).some(Boolean)) throw new Error("Runtime role has forbidden object ownership, table or routine authority");
  const missing = (await client.query(`SELECT
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND CASE WHEN c.relkind IN ('r','p') THEN NOT
      (has_table_privilege(c.oid,'SELECT') AND has_table_privilege(c.oid,'INSERT') AND
        (c.relname='audit_events' OR (has_table_privilege(c.oid,'UPDATE') AND has_table_privilege(c.oid,'DELETE')))) ELSE false END) AS tables,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND CASE WHEN c.relkind='S' THEN NOT
      (has_sequence_privilege(c.oid,'USAGE') AND has_sequence_privilege(c.oid,'SELECT')) ELSE false END) AS sequences`)).rows[0];
  if (Object.values(missing).some(Boolean)) throw new Error("Runtime role lacks required application DML/sequence privileges");
  await client.query("SELECT id FROM public.tenants LIMIT 0");
  return { status: "PASS", action: "verify-runtime", role: expectedUser, clusterAdministration: false, ddl: false, migrationLedgerAccess: false, crossDatabaseConnect: false, auditMutation: false };
}

async function main() {
  const action = process.argv[2];
  if (!["apply", "rollback", "verify-runtime"].includes(action)) throw new Error("Use apply, rollback <state.json>, or verify-runtime");
  const config = action === "verify-runtime" ? {
    host: process.env.PGHOST, port: +(process.env.PGPORT ?? 5432), database: roleName(process.env.PGDATABASE),
    bootstrap: roleName(process.env.PGUSER), runtime: roleName(process.env.POSTGRES_RUNTIME_USER ?? "yaseir_runtime"), password: secret(process.env, "PGPASSWORD"),
  } : profileConfiguration();
  const client = new pg.Client({ host: config.host, port: config.port, database: config.database, user: config.bootstrap, password: config.password,
    application_name: "yaseir-role-profile", connectionTimeoutMillis: 10000, statement_timeout: 30000, lock_timeout: 5000 });
  try {
    await client.connect();
    const result = action === "verify-runtime" ? await verifyRuntime(client, config.runtime)
      : action === "rollback" ? await rollbackProfile(client, config, process.argv[3])
      : await applyProfile(client, config, process.env.YASEIR_DB_ROLE_STATE_DIR ?? "/var/lib/yaseir-role-state");
    console.log(JSON.stringify(result));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    // SQL/connection error text can contain role/password statements. Never
    // print driver messages or queries; policy diagnostics above are fixed.
    console.error(JSON.stringify({ status: "FAIL", action: process.argv[2], error: error.code ? `PostgreSQL refused role-profile operation (${error.code})` : error.message }));
    process.exitCode = 1;
  });
}
