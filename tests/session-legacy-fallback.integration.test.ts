import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { validateManager } from "../src/lib/manager-auth";
import { validateCustomer } from "../src/lib/customer-auth";
import { validatePlatformOwner } from "../src/lib/platform-auth";
import { applyMigrations, closePool, pool, truncateAll, hasTestDatabase } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

function legacyJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = header + "." + payload;
  const signature = createHmac("sha256", process.env.GATEWAY_JWT_SECRET!).update(data).digest("base64url");
  return data + "." + signature;
}

suite("legacy authentication fallback", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "legacy-fallback-test-secret-32-characters";
    await applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    await pool().query("INSERT INTO tenants (id, name) VALUES ($1, $2)", ["tenant_legacy_test", "Legacy Test Tenant"]);
    await pool().query(
      "INSERT INTO users (id, email, password_hash, email_verified_at, is_platform_owner) VALUES ($1, $2, $3, clock_timestamp(), false)",
      ["user_legacy_test", "legacy@example.test", "unused"],
    );
    await pool().query(
      "INSERT INTO tenant_users (user_id, tenant_id, role) VALUES ($1, $2, $3)",
      ["user_legacy_test", "tenant_legacy_test", "admin"],
    );
    await pool().query(
      "INSERT INTO users (id, email, password_hash, email_verified_at, is_platform_owner) VALUES ($1, $2, $3, clock_timestamp(), true)",
      ["platform_legacy_test", "platform-legacy@example.test", "unused"],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it("keeps an existing manager legacy JWT valid until its original 8-hour expiry", async () => {
    const row = (await pool().query(
      "SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint AS now_sec",
    )).rows[0];
    const nowSec = Number(row.now_sec);
    const jti = "legacy_mgr_" + randomBytes(8).toString("hex");
    await pool().query(
      "INSERT INTO manager_sessions (jti, tenant_id, user_id, role, expires_at) VALUES ($1, $2, $3, $4, clock_timestamp() + interval '8 hours')",
      [jti, "tenant_legacy_test", "user_legacy_test", "admin"],
    );
    const token = legacyJwt({
      jti,
      iat: nowSec,
      exp: nowSec + 8 * 60 * 60,
      sub: "manager",
      tenantId: "tenant_legacy_test",
      userId: "user_legacy_test",
      role: "admin",
    });

    const claims = await validateManager(new Request("http://gateway.test/api/auth/manager/me", {
      headers: { cookie: "mgr_session=" + token },
    }));
    expect(claims).not.toBeNull();
    expect(claims?.jti).toBe(jti);
    expect(claims?.ver).toBeUndefined();
    expect(claims?.familyId).toBeUndefined();
  });

  it("keeps an existing customer legacy JWT valid through the shared customer validation path", async () => {
    const row = (await pool().query(
      "SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint AS now_sec",
    )).rows[0];
    const nowSec = Number(row.now_sec);
    const jti = "legacy_cust_" + randomBytes(8).toString("hex");
    await pool().query(
      "INSERT INTO manager_sessions (jti, tenant_id, user_id, role, expires_at) VALUES ($1, $2, $3, $4, clock_timestamp() + interval '8 hours')",
      [jti, "tenant_legacy_test", "user_legacy_test", "admin"],
    );
    const token = legacyJwt({
      jti,
      iat: nowSec,
      exp: nowSec + 8 * 60 * 60,
      sub: "manager",
      tenantId: "tenant_legacy_test",
      userId: "user_legacy_test",
      role: "admin",
    });

    const claims = await validateCustomer(new Request("http://gateway.test/api/auth/me", {
      headers: { cookie: "mgr_session=" + token },
    }));
    expect(claims).not.toBeNull();
    expect(claims?.jti).toBe(jti);
  });

  it("keeps an existing platform legacy JWT valid through the platform fallback", async () => {
    const row = (await pool().query(
      "SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint AS now_sec",
    )).rows[0];
    const nowSec = Number(row.now_sec);
    const jti = "legacy_platform_" + randomBytes(8).toString("hex");
    await pool().query(
      "INSERT INTO platform_sessions (jti, user_id, expires_at) VALUES ($1, $2, clock_timestamp() + interval '8 hours')",
      [jti, "platform_legacy_test"],
    );
    const token = legacyJwt({
      jti,
      iat: nowSec,
      exp: nowSec + 8 * 60 * 60,
      sub: "platform_owner",
      userId: "platform_legacy_test",
      email: "platform-legacy@example.test",
    });

    const claims = await validatePlatformOwner(new Request("http://gateway.test/api/platform/me", {
      headers: { cookie: "plt_session=" + token },
    }));
    expect(claims).not.toBeNull();
    expect(claims?.jti).toBe(jti);
    expect(claims?.ver).toBeUndefined();
    expect(claims?.familyId).toBeUndefined();
  });
});
