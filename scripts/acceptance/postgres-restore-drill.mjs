/** Disposable loopback restore drill. Private dumps/credentials are removed. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const root = process.cwd(), output = path.resolve(process.argv[2] || "");
assert(process.argv[2] && !fs.existsSync(path.join(output, "result.json")), "Use a new evidence output directory");
fs.mkdirSync(output, { recursive: true });
const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaseir-restore-private-")); fs.chmodSync(privateDir, 0o700);
const require = createRequire(path.join(root, "package.json")), { Pool } = require("pg");
const base = new URL(process.env.DATABASE_URL || ""); assert.equal(base.hostname, "127.0.0.1");
const urlFor = name => { const u = new URL(base); u.pathname = `/${name}`; return u.toString(); };
const suffix = `${Date.now()}_${randomBytes(3).toString("hex")}`, sourceName = `yaseir_restore_source_${suffix}`, targetName = `yaseir_restore_target_${suffix}`;
const admin = new Pool({ connectionString: urlFor("postgres"), max: 1 }), created = [];
const digest = value => createHash("sha256").update(value).digest("hex");
let source, target;
const result = { startedUtc: new Date().toISOString(), sourceName, targetName, syntheticOnly: true, checks: [] };
const q = name => `"${name.replaceAll('"', '""')}"`;
async function snapshot(pool) {
  const tables = (await pool.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename")).rows, counts = {};
  for (const t of tables) {
    const rows = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${q(t.schemaname)}.${q(t.tablename)} t ORDER BY to_jsonb(t)::text`)).rows;
    counts[`${t.schemaname}.${t.tablename}`] = { count: rows.length, sha256: digest(JSON.stringify(rows)) };
  }
  const indexes = (await pool.query("SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename,indexname")).rows;
  const sequences = (await pool.query("SELECT schemaname,sequencename,start_value,min_value,max_value,increment_by,cycle,last_value FROM pg_sequences WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,sequencename")).rows;
  return { tables: counts, indexesSha256: digest(JSON.stringify(indexes)), indexCount: indexes.length, sequences };
}
function command(name, script, args, env, expected = 0) {
  const started = Date.now(), r = spawnSync("sh", [path.join(root, script), ...args], { env, encoding: "utf8", timeout: 90000 });
  fs.writeFileSync(path.join(output, `${name}.log`), (r.stdout || "") + (r.stderr || ""));
  result.checks.push({ name, exitCode: r.status, milliseconds: Date.now() - started });
  if (expected === 0) assert.equal(r.status, 0, `${name} failed; see its log`); else assert.notEqual(r.status, 0, `${name} unexpectedly accepted`);
}
try {
  for (const name of [sourceName, targetName]) { await admin.query(`CREATE DATABASE ${q(name)}`); created.push(name); }
  source = new Pool({ connectionString: urlFor(sourceName), max: 2, options: "-c timezone=UTC" });
  target = new Pool({ connectionString: urlFor(targetName), max: 2, options: "-c timezone=UTC" });
  const { migrateByHash } = await import(pathToFileURL(path.join(root, "scripts/db-migrate.ts")).href);
  const migration = await source.connect(); try { await migrateByHash(migration, path.join(root, "drizzle")); } finally { migration.release(); }
  process.env.DATABASE_URL = urlFor(sourceName);
  // Populate core License-Only Control Plane records directly across live tables.
  const tenantId = `restore_tenant_${suffix}`, planId = `restore_plan_${suffix}`, apiKeyId = `restore_key_${suffix}`;
  const installationId = randomUUID(), auditId = `restore_audit_${suffix}`;
  await source.query("INSERT INTO tenants(id,name,odoo_idempotency_mode) VALUES($1,$2,'strict_v2')", [tenantId, `Synthetic restore tenant ${suffix}`]);
  await source.query("INSERT INTO plans(id,name,entitlements) VALUES($1,$2,$3::jsonb)", [planId, `Synthetic restore plan ${suffix}`, JSON.stringify({ max_agents: "unlimited", max_printers: "unlimited" })]);
  await source.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'active',now()-interval '1 minute',now()+interval '1 year')", [tenantId, planId]);
  await source.query("INSERT INTO api_keys(id,tenant_id,name,hashed_key,odoo_enabled) VALUES($1,$2,'Synthetic restore key',$3,true)", [apiKeyId, tenantId, digest(randomBytes(32))]);
  await source.query("INSERT INTO odoo_installations(id,tenant_id,name,secret_hash) VALUES($1,$2,'Synthetic restore installation',$3)", [installationId, tenantId, digest(randomBytes(32))]);
  await source.query("INSERT INTO odoo_installation_credentials(tenant_id,installation_id,api_key_id) VALUES($1,$2,$3)", [tenantId, installationId, apiKeyId]);
  await source.query("INSERT INTO audit_events(id,tenant_id,actor_type,actor_id,action) VALUES($1,$2,'system','synthetic-restore-drill','synthetic.restore.seeded')", [auditId, tenantId]);
  // Populate real password/session authority so restore parity covers nonempty data.
  const jwtKeyFile = path.join(privateDir, "jwt-key"), restoredJwtKeyFile = path.join(privateDir, "restored-jwt-key");
  fs.writeFileSync(jwtKeyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  fs.copyFileSync(jwtKeyFile, restoredJwtKeyFile); fs.chmodSync(restoredJwtKeyFile, 0o600);
  process.env.GATEWAY_JWT_SECRET_FILE = jwtKeyFile;
  const { hashPassword } = await import(pathToFileURL(path.join(root, "src/lib/password.ts")).href);
  const { credentialVersionFor } = await import(pathToFileURL(path.join(root, "src/lib/session-credentials.ts")).href);
  const userId = `restore_owner_${suffix}`, familyId = `restore_family_${suffix}`;
  const passwordHash = await hashPassword(randomBytes(40).toString("base64url"));
  const credentialVersion = credentialVersionFor(userId, passwordHash);
  await source.query("INSERT INTO users(id,email,password_hash,email_verified_at,is_platform_owner) VALUES($1,$2,$3,now(),true)", [userId, `${userId}@synthetic.invalid`, passwordHash]);
  await source.query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES($1,$2,'owner')", [userId, tenantId]);
  await source.query("INSERT INTO platform_sessions(jti,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [`restore_session_${suffix}`, userId]);
  for (const [id, issued] of [[`refresh_current_${suffix}`, 5], [`refresh_previous_${suffix}`, 10]]) {
    await source.query("INSERT INTO refresh_tokens(id,family_id,kind,user_id,token_hash,issued_at,family_created_at,expires_at) VALUES($1,$2,'platform',$3,$4,now()-make_interval(mins=>$5),now()-interval '10 minutes',now()+interval '7 days')", [id, familyId, userId, digest(randomBytes(32)), issued]);
  }
  await source.query("UPDATE refresh_tokens SET revoked_at=now()-interval '5 minutes',revoked_reason='rotated',replaced_by=$1,replaced_at=now()-interval '5 minutes' WHERE id=$2", [`refresh_current_${suffix}`, `refresh_previous_${suffix}`]);
  await source.query("INSERT INTO platform_session_security(family_id,user_id,password_version,password_verified_at,last_seen_at,expires_at) VALUES($1,$2,$3,now(),now(),now()+interval '1 hour')", [familyId, userId, digest(passwordHash)]);
  for (const kind of ["customer", "manager"]) {
    const workspaceFamily = randomBytes(16).toString("hex"), tokenId = randomBytes(16).toString("hex");
    await source.query("INSERT INTO refresh_tokens(id,family_id,kind,tenant_id,user_id,role,email,token_hash,issued_at,family_created_at,expires_at) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,now()-interval '5 minutes',now()-interval '10 minutes',now()+interval '1 hour')", [tokenId, workspaceFamily, kind, tenantId, userId, `${userId}@synthetic.invalid`, digest(randomBytes(32))]);
    await source.query("INSERT INTO workspace_session_security(family_id,kind,tenant_id,user_id,credential_version,created_at,password_verified_at,last_seen_at,expires_at) VALUES($1,$2,$3,$4,$5,now()-interval '10 minutes',now()-interval '5 minutes',now()-interval '1 minute',now()+interval '1 hour')", [workspaceFamily, kind, tenantId, userId, credentialVersion]);
  }
  const before = await snapshot(source), passwordFile = path.join(privateDir, "password");
  fs.writeFileSync(passwordFile, decodeURIComponent(base.password), { mode: 0o600 });
  const env = { ...process.env, PGHOST: base.hostname, PGPORT: base.port || "5432", PGUSER: decodeURIComponent(base.username), PGDATABASE: sourceName,
    PGPASSWORD_FILE: passwordFile, BACKUP_DIR: path.join(privateDir, "backups") };
  delete env.PGPASSWORD;
  command("backup", "scripts/postgres-backup.sh", [], env);
  const name = fs.readdirSync(env.BACKUP_DIR).find(n => n.endsWith(".dump")); assert(name);
  const dump = path.join(env.BACKUP_DIR, name), bytes = fs.readFileSync(dump);
  assert.equal(fs.statSync(dump).mode & 0o777, 0o600);
  const restoreEnv = { ...env, PGDATABASE: targetName, RESTORE_CONFIRM: targetName };
  command("wrong-target-refused", "scripts/postgres-restore.sh", [dump], { ...restoreEnv, RESTORE_CONFIRM: sourceName }, 1);
  const corrupt = path.join(env.BACKUP_DIR, "corrupt.dump");
  fs.writeFileSync(corrupt, bytes.subarray(0, Math.floor(bytes.length / 2)), { mode: 0o600 });
  fs.writeFileSync(corrupt + ".sha256", `${digest(bytes)}  corrupt.dump\n`, { mode: 0o600 });
  command("checksum-mismatch-refused", "scripts/postgres-restore.sh", [corrupt], restoreEnv, 1);
  assert.equal((await target.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rows[0].n, 0);
  command("restore", "scripts/postgres-restore.sh", [dump], restoreEnv);
  const after = await snapshot(target); assert.deepEqual(after, before, "Every table, identity sequence, index and migration ledger must survive");
  process.env.GATEWAY_JWT_SECRET_FILE = restoredJwtKeyFile;
  assert.equal(credentialVersionFor(userId, passwordHash), credentialVersion, "The separately retained signing key must preserve credential-version authority");
  assert.equal((await target.query("SELECT password_version FROM platform_session_security WHERE family_id=$1", [familyId])).rows[0].password_version, digest(passwordHash));
  result.sessionAuthorityPreservation = { tables: Object.fromEntries(["users", "tenant_users", "platform_sessions", "refresh_tokens", "platform_session_security", "workspace_session_security"].map(name => [name, before.tables[`public.${name}`].count])), externalSigningKeyRestore: "PASS",
    scope: "Password hashes, account roles, rotated platform refresh history, customer and manager families, exact workspace kind/tenant/role/family/SID bindings, credential fingerprints and original password/idle/absolute deadlines survive." };
  command("nonempty-target-refused", "scripts/postgres-restore.sh", [dump], restoreEnv, 1);
  assert.deepEqual(await snapshot(target), after, "Refusal must not modify restored identity");
  const repeat = await target.connect(); try { await migrateByHash(repeat, path.join(root, "drizzle")); } finally { repeat.release(); }
  assert.deepEqual(await snapshot(target), after, "Repeat migrations must preserve restored identities/ledger");
  const relations = (await target.query("SELECT t.id tenant_id, s.plan_id, s.status subscription_status, i.id installation_id, c.api_key_id FROM tenants t JOIN tenant_subscriptions s ON s.tenant_id=t.id JOIN odoo_installations i ON i.tenant_id=t.id JOIN odoo_installation_credentials c ON c.installation_id=i.id AND c.tenant_id=i.tenant_id JOIN api_keys k ON k.id=c.api_key_id AND k.tenant_id=c.tenant_id WHERE t.id=$1", [tenantId])).rows;
  assert.equal(relations.length, 1);
  assert.equal(relations[0].subscription_status, "active");
  assert.equal(relations[0].installation_id, installationId);
  assert.equal(relations[0].api_key_id, apiKeyId);
  assert.equal((await target.query("SELECT count(*)::int n FROM audit_events WHERE id=$1", [auditId])).rows[0].n, 1);
  result.status = "PASS"; result.snapshot = before; result.identityRelationships = relations;
  result.archive = { bytes: bytes.length, sha256: digest(bytes), mode: "0600", retained: false };
  result.repeatMigrations = "PASS";
  result.limitations = ["Local synthetic logical restore only; no production RPO/RTO or off-site durability claim", "External Odoo filestore/enrollment proofs and encryption keys require their separate coordinated restore gate"];
} catch (e) { result.status = "FAIL"; result.error = { name: e.name, message: e.message }; process.exitCode = 1; }
finally {
  if (source) await source.end(); if (target) await target.end();
  result.cleanup = [];
  for (const name of created) { try { await admin.query(`DROP DATABASE ${q(name)}`); result.cleanup.push({ database: name, dropped: true }); } catch (e) { result.cleanup.push({ database: name, dropped: false, error: e.message }); result.status = "FAIL"; process.exitCode = 1; } }
  await admin.end(); fs.rmSync(privateDir, { recursive: true, force: true }); result.privateMaterialRemoved = true;
  result.finishedUtc = new Date().toISOString(); fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ status: result.status, tables: Object.keys(result.snapshot?.tables || {}).length, indexes: result.snapshot?.indexCount, checks: result.checks, cleanup: result.cleanup, output }));
}
