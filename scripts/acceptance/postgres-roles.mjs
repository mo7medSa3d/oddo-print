#!/usr/bin/env node
/** Real privilege acceptance against a new, dedicated, disposable PG cluster.
 * The caller owns cluster creation/removal. No existing service is permitted.
 * node --import tsx scripts/acceptance/postgres-roles.mjs /new/evidence/path
 */
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyProfile, rollbackProfile, verifyRuntime } from "../postgres-role-profile.mjs";
import { AUDIT_REPAIRS, migrateByHash } from "../db-migrate.ts";

const output = path.resolve(process.argv[2]);
assert(process.env.YASEIR_FRESH_ROLE_CLUSTER === "1", "A dedicated fresh role-test cluster is required");
assert(!fs.existsSync(path.join(output, "result.json")), "New result directory required");
fs.mkdirSync(output, { recursive: true });
const privateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yaseir-role-acceptance-"));
fs.chmodSync(privateDirectory, 0o700);
const config = { host: process.env.PGHOST, port: +process.env.PGPORT, database: "yaseir_role_acceptance", bootstrap: process.env.PGUSER,
  password: process.env.PGPASSWORD, owner: "yaseir_owner", runtime: "yaseir_runtime", ownerPassword: randomBytes(32).toString("hex"), runtimePassword: randomBytes(32).toString("hex") };
assert(["127.0.0.1", "localhost", "::1"].includes(config.host));
const report = { status: "RUNNING", startedUtc: new Date().toISOString(), checks: [], syntheticOnly: true };
const connections = new Set();
async function client(user, password, database = config.database) {
  const connection = new pg.Client({ host: config.host, port: config.port, user, password, database, connectionTimeoutMillis: 3000 });
  connections.add(connection); await connection.connect(); return connection;
}
async function close(connection) { if (connection) { await connection.end(); connections.delete(connection); } }
const checked = (name, details = {}) => { report.checks.push({ name, status: "PASS", ...details }); console.log(JSON.stringify(report.checks.at(-1))); };
async function denied(connection, query, codes = ["42501"]) {
  await assert.rejects(connection.query(query), error => codes.includes(error.code), `Forbidden SQL unexpectedly allowed: ${query}`);
}
let administrator;
try {
  const initial = await client(config.bootstrap, config.password, "postgres");
  assert.equal((await initial.query("SELECT count(*)::int n FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')")).rows[0].n, 0);
  await initial.query(`CREATE DATABASE ${config.database}`); await close(initial);
  administrator = await client(config.bootstrap, config.password);
  await administrator.query("CREATE TABLE public.legacy_marker(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL)");
  await administrator.query("INSERT INTO public.legacy_marker(value) VALUES ('synthetic-preserved-identity')");
  const initialRows = (await administrator.query("SELECT * FROM public.legacy_marker ORDER BY id")).rows;
  if (process.env.YASEIR_ROLE_BASELINE_SHARED === "1") {
    const attributes = (await administrator.query("SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0];
    report.baselineAttributes = attributes;
    assert.equal(attributes.rolsuper, false, "Shared official bootstrap role is a superuser and cannot be the runtime role");
  }
  const applied = await applyProfile(administrator, config, privateDirectory);
  checked("profile-applies-with-preserved-existing-row", { stateMode: fs.statSync(applied.stateFile).mode & 0o777 });
  assert.equal(fs.statSync(applied.stateFile).mode & 0o777, 0o600);
  assert.deepEqual((await administrator.query("SELECT * FROM public.legacy_marker ORDER BY id")).rows, initialRows);
  await close(administrator); administrator = null;
  const owner = await client(config.owner, config.ownerPassword);
  await migrateByHash(owner, path.join(process.cwd(), "drizzle"));
  const ledgerRowsBefore = (await owner.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
  const expectedMigrationHashes = readMigrationFiles({ migrationsFolder: path.join(process.cwd(), "drizzle") }).map(row => row.hash)
    .concat(AUDIT_REPAIRS.map(sql => createHash("sha256").update(sql).digest("hex")));
  assert.deepEqual(ledgerRowsBefore.map(row => row.hash), expectedMigrationHashes, "Restricted owner must apply every exact source migration and forward repair");
  const ledgerBefore = ledgerRowsBefore.length;
  await owner.query("CREATE TABLE public.future_migration_table(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL)");
  await migrateByHash(owner, path.join(process.cwd(), "drizzle"));
  assert.deepEqual((await owner.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows, ledgerRowsBefore,
    "Repeated owner migrations must preserve every ledger row and timestamp");
  const sessionAuthorityTables = ["platform_session_security", "workspace_session_security"];
  const sessionOwners = (await owner.query("SELECT tablename,tableowner FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename", [sessionAuthorityTables])).rows;
  assert.deepEqual(sessionOwners, sessionAuthorityTables.map(tablename => ({ tablename, tableowner: config.owner })));
  checked("separate-owner-applies-all-migrations-and-future-ddl", { migrationRecords: ledgerBefore, exactLedgerHashes: true, sessionPolicyTables: sessionOwners.length });
  await denied(owner, "CREATE ROLE forbidden_owner_escalation");
  await denied(owner, "CREATE DATABASE forbidden_owner_database");
  checked("migration-owner-cannot-administer-cluster");
  await close(owner);
  const runtime = await client(config.runtime, config.runtimePassword);
  await verifyRuntime(runtime, config.runtime);
  const hasLegacyBilling = Boolean((await runtime.query("SELECT to_regnamespace('legacy_billing') IS NOT NULL AS present")).rows[0].present);
  if (hasLegacyBilling) {
    for (const archived of ["billing_events", "print_usage_periods", "plan_provider_history", "subscription_provider_history"]) {
      await denied(runtime, `SELECT * FROM legacy_billing.${archived}`);
    }
    checked("runtime-legacy-archive-access-denied", { archivedTables: 4 });
  } else {
    checked("runtime-legacy-archive-access-denied", { archivedTables: 0, skippedFreshCleanSchema: true });
  }
  await runtime.query("INSERT INTO public.future_migration_table(value) VALUES ('new-table-default-grant')");
  await runtime.query("UPDATE public.future_migration_table SET value='updated' WHERE id=1");
  assert.equal((await runtime.query("SELECT value FROM public.future_migration_table WHERE id=1")).rows[0].value, "updated");
  await runtime.query("DELETE FROM public.future_migration_table WHERE id=1");
  checked("runtime-dml-and-future-sequence-default-grants");
  const missing = (await runtime.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND NOT (has_table_privilege(quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT') AND has_table_privilege(quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT') AND (tablename='audit_events' OR (has_table_privilege(quote_ident(schemaname)||'.'||quote_ident(tablename),'UPDATE') AND has_table_privilege(quote_ident(schemaname)||'.'||quote_ident(tablename),'DELETE'))))")).rows[0].n;
  assert.equal(missing, 0);
  // Exercise core License-Only Control Plane tables under the restricted runtime role.
  await runtime.query("INSERT INTO public.tenants(id,name) VALUES ('role-tenant','Synthetic privilege tenant')");
  await runtime.query("INSERT INTO public.plans(id,name) VALUES ('role-plan','Synthetic privilege plan')");
  await runtime.query("INSERT INTO public.tenant_subscriptions(tenant_id,plan_id,status) VALUES ('role-tenant','role-plan','active')");
  await runtime.query("INSERT INTO public.api_keys(id,tenant_id,name,hashed_key) VALUES ('role-key','role-tenant','Synthetic role key','synthetic-key-hash')");
  await runtime.query("INSERT INTO public.odoo_installations(id,tenant_id,name,secret_hash) VALUES ('role-install','role-tenant','Synthetic role installation','synthetic-install-hash')");
  await runtime.query("INSERT INTO public.odoo_installation_credentials(tenant_id,installation_id,api_key_id) VALUES ('role-tenant','role-install','role-key')");
  assert.equal((await runtime.query("SELECT count(*)::int n FROM odoo_installation_credentials WHERE tenant_id='role-tenant' AND installation_id='role-install' AND api_key_id='role-key'")).rows[0].n, 1);
  checked("runtime-production-table-dml");
  await runtime.query("INSERT INTO audit_events(id,tenant_id,actor_type,actor_id,action) VALUES('role-audit','role-tenant','system','synthetic-role-probe','synthetic.audit.appended')");
  assert.equal((await runtime.query("SELECT action FROM audit_events WHERE id='role-audit'")).rows[0].action, "synthetic.audit.appended");
  for (const statement of ["UPDATE audit_events SET action='forged' WHERE id='role-audit'", "DELETE FROM audit_events WHERE id='role-audit'", "TRUNCATE audit_events"]) await denied(runtime, statement);
  assert.equal((await runtime.query("SELECT action FROM audit_events WHERE id='role-audit'")).rows[0].action, "synthetic.audit.appended");
  checked("runtime-audit-select-insert-allowed-update-delete-truncate-denied", { denials: 3 });
  // Execute the real lifecycle transaction under the runtime identity; tenant
  // deletion is a state transition which must retain old and new audit rows.
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousDatabaseFile = process.env.DATABASE_URL_FILE;
  const runtimeUrl = new URL(`postgresql://${config.host}:${config.port}/${config.database}`);
  runtimeUrl.username = config.runtime; runtimeUrl.password = config.runtimePassword;
  process.env.DATABASE_URL = runtimeUrl.href;
  delete process.env.DATABASE_URL_FILE;
  const { pool: applicationPool } = await import("../../src/db/index.ts");
  try {
    const { transitionTenantLifecycle } = await import("../../src/lib/tenant-lifecycle.ts");
    const deletion = await transitionTenantLifecycle("role-tenant", "deleted", "synthetic append-only acceptance", { type: "system", id: "synthetic-role-probe" });
    assert.equal(deletion.lifecycle, "deleted");
    assert.equal((await runtime.query("SELECT count(*)::int n FROM audit_events WHERE tenant_id='role-tenant' AND action='tenant.lifecycle.deleted'")).rows[0].n, 1);
    assert.equal((await runtime.query("SELECT count(*)::int n FROM audit_events WHERE id='role-audit'")).rows[0].n, 1);
    await denied(runtime, "DELETE FROM tenants WHERE id='role-tenant'", ["23503"]);
    checked("runtime-real-tenant-deletion-retains-audit-and-appends-lifecycle-event");
  } finally {
    await applicationPool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousDatabaseFile === undefined) delete process.env.DATABASE_URL_FILE; else process.env.DATABASE_URL_FILE = previousDatabaseFile;
  }
  const maintenanceOwner = await client(config.owner, config.ownerPassword);
  await maintenanceOwner.query("INSERT INTO audit_events(id,actor_type,action) VALUES('role-maintenance-audit','platform','synthetic.owner.maintenance')");
  await maintenanceOwner.query("UPDATE audit_events SET action='synthetic.owner.corrected' WHERE id='role-maintenance-audit'");
  await maintenanceOwner.query("DELETE FROM audit_events WHERE id='role-maintenance-audit'");
  assert.equal((await maintenanceOwner.query("SELECT count(*)::int n FROM audit_events WHERE id='role-maintenance-audit'")).rows[0].n, 0);
  await close(maintenanceOwner);
  checked("migration-owner-retains-explicit-audit-maintenance-authority");
  await runtime.query("BEGIN");
  try {
    const proof = createHash("sha256").update("synthetic-privilege-probe").digest("hex");
    await runtime.query("INSERT INTO users(id,email,password_hash,email_verified_at,is_platform_owner) VALUES('role-session-user','role-session-user@synthetic.invalid','synthetic-unused-password-hash',now(),true)");
    // These unused records check SQL privileges, not password authentication.
    await runtime.query("INSERT INTO platform_session_security(family_id,user_id,password_version,password_verified_at,last_seen_at,expires_at) VALUES('role-platform-family','role-session-user',$1,now(),now(),now()+interval '1 hour')", [proof]);
    await runtime.query("INSERT INTO workspace_session_security(family_id,kind,tenant_id,user_id,credential_version,created_at,password_verified_at,last_seen_at,expires_at) VALUES('role-workspace-family','customer','role-tenant','role-session-user',$1,now(),now(),now(),now()+interval '1 hour')", [proof]);
    for (const table of sessionAuthorityTables) {
      assert.equal((await runtime.query(`SELECT count(*)::int n FROM ${table} WHERE user_id='role-session-user'`)).rows[0].n, 1);
      assert.equal((await runtime.query(`UPDATE ${table} SET last_seen_at=clock_timestamp() WHERE user_id='role-session-user'`)).rowCount, 1);
      assert.equal((await runtime.query(`DELETE FROM ${table} WHERE user_id='role-session-user'`)).rowCount, 1);
    }
  } finally { await runtime.query("ROLLBACK"); }
  checked("runtime-can-read-insert-update-delete-both-session-authority-tables", { tables: sessionAuthorityTables.length, fixtureRolledBack: true });
  for (const statement of ["CREATE TABLE public.forbidden_ddl(id int)", "ALTER TABLE public.legacy_marker ADD COLUMN forbidden int", "DROP TABLE public.legacy_marker", "CREATE SCHEMA forbidden_schema", "CREATE TEMP TABLE forbidden_temp(id int)", "TRUNCATE public.legacy_marker", "CREATE ROLE forbidden_role", "SET ROLE yaseir_owner", "SELECT * FROM drizzle.__drizzle_migrations", "SELECT pg_read_file('PG_VERSION')"]) await denied(runtime, statement);
  checked("runtime-ddl-role-ledger-file-and-temp-denied", { denials: 10 });
  const privilegeAdmin = await client(config.bootstrap, config.password);
  for (const grant of ["UPDATE", "DELETE", "UPDATE(action)"]) {
    await privilegeAdmin.query(`GRANT ${grant} ON public.audit_events TO yaseir_runtime`);
    await assert.rejects(verifyRuntime(runtime, config.runtime), /forbidden object ownership, table or routine authority/);
    await privilegeAdmin.query(`REVOKE ${grant} ON public.audit_events FROM yaseir_runtime`);
  }
  checked("runtime-startup-verifier-rejects-audit-mutation-grant-drift", { variants: 3 });
  await privilegeAdmin.query("GRANT UPDATE,DELETE ON public.audit_events TO yaseir_runtime");
  await privilegeAdmin.query("GRANT UPDATE(action) ON public.audit_events TO yaseir_runtime");
  const repairOwner = await client(config.owner, config.ownerPassword);
  await migrateByHash(repairOwner, path.join(process.cwd(), "drizzle"));
  assert.deepEqual((await repairOwner.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows, ledgerRowsBefore);
  await close(repairOwner);
  await verifyRuntime(runtime, config.runtime);
  await denied(runtime, "UPDATE audit_events SET action='forged-after-migration' WHERE id='role-audit'");
  await denied(runtime, "DELETE FROM audit_events WHERE id='role-audit'");
  checked("owner-migration-repairs-table-and-column-audit-grants-without-changing-ledger");
  await privilegeAdmin.query("GRANT TRUNCATE ON public.legacy_marker TO yaseir_runtime");
  await assert.rejects(verifyRuntime(runtime, config.runtime), /forbidden object ownership, table or routine authority/);
  await privilegeAdmin.query("REVOKE TRUNCATE ON public.legacy_marker FROM yaseir_runtime");
  await privilegeAdmin.query("GRANT UPDATE ON SEQUENCE public.legacy_marker_id_seq TO yaseir_runtime");
  await assert.rejects(verifyRuntime(runtime, config.runtime), /forbidden object ownership, table or routine authority/);
  await privilegeAdmin.query("REVOKE UPDATE ON SEQUENCE public.legacy_marker_id_seq FROM yaseir_runtime");
  await privilegeAdmin.query("ALTER TABLE public.future_migration_table OWNER TO yaseir_runtime");
  await assert.rejects(verifyRuntime(runtime, config.runtime), /forbidden object ownership, table or routine authority/);
  await privilegeAdmin.query("ALTER TABLE public.future_migration_table OWNER TO yaseir_owner");
  await privilegeAdmin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON public.future_migration_table TO yaseir_runtime");
  await privilegeAdmin.query("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO yaseir_runtime");
  await verifyRuntime(runtime, config.runtime);
  if (hasLegacyBilling) {
    await privilegeAdmin.query("GRANT USAGE ON SCHEMA legacy_billing TO yaseir_runtime");
    await assert.rejects(verifyRuntime(runtime, config.runtime), /forbidden schema/);
    await privilegeAdmin.query("REVOKE USAGE ON SCHEMA legacy_billing FROM yaseir_runtime");
    await privilegeAdmin.query("GRANT SELECT ON legacy_billing.billing_events TO yaseir_runtime");
    await assert.rejects(verifyRuntime(runtime, config.runtime), /forbidden object ownership, table or routine authority/);
    await privilegeAdmin.query("REVOKE SELECT ON legacy_billing.billing_events FROM yaseir_runtime");
  }
  await close(privilegeAdmin);
  checked("runtime-startup-verifier-rejects-grant-or-object-ownership-drift");
  for (const target of ["postgres", "template1"]) {
    await assert.rejects(client(config.runtime, config.runtimePassword, target), error => error.code === "42501");
  }
  checked("runtime-cross-database-connections-denied", { databases: 2 });
  await close(runtime);
  // Failed connection attempts are also explicitly closed before the exclusive
  // profile transaction checks for active target-database clients.
  for (const connection of [...connections]) await close(connection);
  administrator = await client(config.bootstrap, config.password);
  await administrator.query("ALTER ROLE yaseir_runtime INHERIT");
  const ownerBeforeRefusal = (await administrator.query("SELECT pg_get_userbyid(datdba) owner FROM pg_database WHERE datname=current_database()")).rows[0].owner;
  await assert.rejects(applyProfile(administrator, config, privateDirectory), /Existing role does not match/);
  assert.equal((await administrator.query("SELECT rolinherit FROM pg_roles WHERE rolname='yaseir_runtime'")).rows[0].rolinherit, true);
  assert.equal((await administrator.query("SELECT pg_get_userbyid(datdba) owner FROM pg_database WHERE datname=current_database()")).rows[0].owner, ownerBeforeRefusal);
  await administrator.query("ALTER ROLE yaseir_runtime NOINHERIT");
  checked("noncanonical-existing-role-inheritance-refused-without-mutation");
  const second = await applyProfile(administrator, config, privateDirectory);
  assert(second.stateFile !== applied.stateFile);
  checked("profile-idempotent-with-unchanged-credentials");
  await assert.rejects(applyProfile(administrator, { ...config, runtimePassword: randomBytes(32).toString("hex") }, privateDirectory), /configured credential/);
  checked("configured-credential-mismatch-refused-without-rotation");
  await administrator.query("CREATE ROLE unrelated_role NOLOGIN");
  await assert.rejects(applyProfile(administrator, config, privateDirectory), /Dedicated cluster required/);
  await administrator.query("DROP ROLE unrelated_role");
  checked("shared-cluster-role-refused");
  const rowsBeforeRollback = (await administrator.query("SELECT * FROM public.legacy_marker ORDER BY id")).rows;
  await rollbackProfile(administrator, config, applied.stateFile);
  assert.deepEqual((await administrator.query("SELECT * FROM public.legacy_marker ORDER BY id")).rows, rowsBeforeRollback);
  assert.equal((await administrator.query("SELECT pg_get_userbyid(relowner) owner FROM pg_class WHERE oid='public.legacy_marker'::regclass")).rows[0].owner, config.bootstrap);
  assert.equal((await administrator.query("SELECT count(*)::int n FROM odoo_installations WHERE id='role-install'")).rows[0].n, 1);
  assert.equal((await administrator.query("SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('yaseir_owner','yaseir_runtime') AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole)")).rows[0].n, 0);
  checked("recorded-ownership-rollback-preserves-rows-and-disables-new-roles");
  await applyProfile(administrator, config, privateDirectory);
  checked("profile-reapplies-after-permission-rollback");
  const reappliedRuntime = await client(config.runtime, config.runtimePassword);
  await verifyRuntime(reappliedRuntime, config.runtime);
  await denied(reappliedRuntime, "UPDATE audit_events SET action='forged-after-reapply' WHERE id='role-audit'");
  await denied(reappliedRuntime, "DELETE FROM audit_events WHERE id='role-audit'");
  await close(reappliedRuntime);
  checked("profile-reapply-preserves-append-only-audit-access");
  const publicState = JSON.parse(fs.readFileSync(applied.stateFile, "utf8"));
  const stateText = JSON.stringify(publicState);
  assert(![config.password, config.ownerPassword, config.runtimePassword, "SCRAM-SHA-256"].some(value => stateText.includes(value)));
  report.stateSha256 = createHash("sha256").update(stateText).digest("hex");
  checked("rollback-metadata-excludes-passwords-and-verifiers");
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = /^[0-9A-Z]{5}$/.test(error.code ?? "") ? `PostgreSQL acceptance failed (${error.code}); table=${error.table ?? "unknown"}; column=${error.column ?? "unknown"}` : error.message;
  process.exitCode = 1;
} finally {
  for (const connection of [...connections]) { try { await close(connection); } catch { report.cleanupError = "Connection close failed"; report.status = "FAIL"; process.exitCode = 1; } }
  fs.rmSync(privateDirectory, { recursive: true, force: true });
  report.privateStateRemoved = true;
  report.finishedUtc = new Date().toISOString();
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error, output }));
}
