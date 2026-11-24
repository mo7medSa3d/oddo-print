import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrateByHash } from "../scripts/db-migrate";
import { hashPassword } from "../src/lib/password";
import { credentialVersionFor } from "../src/lib/session-credentials";
import { isPlatformSessionAssured } from "../src/lib/platform-session-security";
import { readWorkspaceSessionState } from "../src/lib/workspace-session-security";
import type { DbTx } from "../src/db";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hasTestDatabase = Boolean(process.env.DATABASE_URL);
const factorTables = [
  "platform_mfa_challenges",
  "platform_mfa_credentials",
  "platform_mfa_grants",
  "platform_mfa_recovery_codes",
  "workspace_mfa_challenges",
  "workspace_mfa_credentials",
  "workspace_mfa_grants",
  "workspace_mfa_recovery_codes",
];

describe.skipIf(!hasTestDatabase)("password-only clean baseline migration", () => {
  let admin: Pool, target: Pool, database: string, passwordHash: string;
  async function apply(folder: string) {
    const client = await target.connect();
    try { await migrateByHash(client, folder); } finally { client.release(); }
  }
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = randomBytes(32).toString("base64url");
    const source = new URL(process.env.DATABASE_URL!); source.pathname = "/postgres";
    admin = new Pool({ connectionString: source.href, max: 1 });
    database = `password_upgrade_${randomBytes(8).toString("hex")}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    source.pathname = `/${database}`;
    target = new Pool({ connectionString: source.href, max: 2, options: "-c timezone=UTC" });
    await apply(join(process.cwd(), "drizzle"));
    passwordHash = await hashPassword(randomBytes(24).toString("base64url"));
  });
  afterAll(async () => {
    await target?.end();
    try { if (database) await admin.query(`DROP DATABASE IF EXISTS "${database}"`); }
    finally { await admin?.end(); }
  });

  it("omits retired MFA tables/columns and enforces password-only session security", async () => {
    expect((await target.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])",
      [factorTables],
    )).rows).toEqual([]);

    const retiredCols = await target.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public'
        AND (
          (table_name='users' AND column_name IN ('platform_mfa_version','workspace_mfa_version'))
          OR (table_name='platform_session_security' AND column_name IN ('mfa_version','method','verified_at'))
          OR (table_name='workspace_session_security' AND column_name IN ('mfa_version','mfa_method','mfa_verified_at'))
        )
    `);
    expect(retiredCols.rows).toEqual([]);

    const proof = credentialVersionFor("owner", passwordHash);
    const pwVersion = digest(passwordHash);
    await target.query("INSERT INTO tenants(id,name) VALUES('pw-tenant','Password-only workspace')");
    await target.query(
      "INSERT INTO users(id,email,password_hash,email_verified_at,is_platform_owner,display_name) VALUES('owner','owner@upgrade.invalid',$1,now(),true,NULL)",
      [passwordHash],
    );
    await target.query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES('owner','pw-tenant','owner')");
    for (const kind of ["platform", "customer", "manager"]) {
      const family = `${kind}-family`, sid = `${kind}-sid`, tenant = kind === "platform" ? null : "pw-tenant";
      await target.query(
        "INSERT INTO refresh_tokens(id,family_id,kind,tenant_id,user_id,role,email,token_hash,issued_at,family_created_at,expires_at) VALUES($1,$2,$3,$4,'owner',$5,'owner@upgrade.invalid',$6,now()-interval '1 minute',now()-interval '10 minutes',now()+interval '1 hour')",
        [sid, family, kind, tenant, kind === "platform" ? null : "owner", digest(randomBytes(32).toString("hex"))],
      );
      if (kind === "platform") {
        await target.query(
          "INSERT INTO platform_session_security(family_id,user_id,password_version,password_verified_at,last_seen_at,expires_at) VALUES($1,'owner',$2,now()-interval '2 minutes',now()-interval '1 minute',now()+interval '1 hour')",
          [family, pwVersion],
        );
      } else {
        await target.query(
          "INSERT INTO workspace_session_security(family_id,kind,tenant_id,user_id,credential_version,created_at,password_verified_at,last_seen_at,expires_at) VALUES($1,$2,'pw-tenant','owner',$3,now()-interval '10 minutes',now()-interval '2 minutes',now()-interval '1 minute',now()+interval '1 hour')",
          [family, kind, proof],
        );
      }
    }
    await target.query(
      "INSERT INTO platform_session_security(family_id,user_id,password_version,password_verified_at,last_seen_at,expires_at,revoked_at) VALUES('revoked-family','owner',$1,now()-interval '10 minutes',now()-interval '8 minutes',now()+interval '1 hour',now()-interval '5 minutes')",
      [pwVersion],
    );

    const connection = drizzle(target) as unknown as DbTx;
    expect(await isPlatformSessionAssured("platform-family", "owner", false, connection)).toBe(true);
    expect(await isPlatformSessionAssured("revoked-family", "owner", false, connection)).toBe(false);
    for (const kind of ["customer", "manager"] as const) {
      expect(await readWorkspaceSessionState({ familyId: `${kind}-family`, kind, tenantId: "pw-tenant", userId: "owner", sid: `${kind}-sid`, role: "owner" }, connection)).not.toBeNull();
    }

    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const tags = journal.entries.map(entry => entry.tag);
    expect(tags).toContain("0000_initial_schema");
    expect((await readdir("drizzle")).filter(n => n.endsWith(".sql"))).toHaveLength(journal.entries.length);

    const ledgerBefore = (await target.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
    expect(ledgerBefore).toHaveLength(journal.entries.length);
    await apply(join(process.cwd(), "drizzle"));
    expect((await target.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows).toEqual(ledgerBefore);
  });
});
