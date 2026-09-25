import { gatewayTestSigningKey } from "./helpers/test-secrets";
import { createHmac, scryptSync } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  closePool,
  pool,
} from "./helpers/pg";
import {
  createManagerSession,
  verifyManagerToken,
  verifyManagerPassword,
  validateManagerClaims,
  validateWorkspaceManager,
} from "../src/lib/manager-auth";

const suite = describe.skipIf(!hasTestDatabase);

suite("manager authentication hardening", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey();
    process.env.MANAGER_USERNAME = "manager";
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
    delete process.env.MANAGER_PASSWORD_HASH;
    delete process.env.MANAGER_PASSWORD;
  });

  beforeEach(async () => {
    await truncateAll();
    await pool().query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, ["tenant_manager_test", "Manager Test Tenant"]);
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("creates a v2 session pair that verifies against the refresh-token ledger", async () => {
    const created = await createManagerSession("tenant_manager_test");
    const claims = await verifyManagerToken(created.token);
    expect(claims).not.toBeNull();
    expect(claims?.jti).toBe(created.jti);
    expect(claims?.sub).toBe("manager");
    expect(claims?.ver).toBe(2);
    expect(claims?.familyId).toBe(created.familyId);

    const row = (await pool().query(
      "SELECT token_hash, family_id, expires_at FROM refresh_tokens WHERE id = $1",
      [created.refreshTokenId],
    )).rows[0];
    expect(row.family_id).toBe(created.familyId);
    expect(row.token_hash).toHaveLength(64);
    expect(row.token_hash).not.toBe(created.refreshToken);
    expect(new Date(row.expires_at).getTime()).toBe(created.refreshExpiresAt.getTime());
    await expect(validateManagerClaims(claims)).resolves.not.toBeNull();
  });

  it("accepts a customer v2 session in workspace auth while manager-only validation stays separate", async () => {
    await pool().query(
      "INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, clock_timestamp())",
      ["user_workspace_test", "workspace@example.test", "unused"],
    );
    await pool().query(
      "INSERT INTO tenant_users (user_id, tenant_id, role) VALUES ($1, $2, $3)",
      ["user_workspace_test", "tenant_manager_test", "admin"],
    );

    const session = await (await import("../src/lib/session-tokens")).issueSessionPair({
      kind: "customer",
      tenantId: "tenant_manager_test",
      userId: "user_workspace_test",
      role: "admin",
      email: "workspace@example.test",
    });

    const request = new Request("http://gateway.test/api/agents", {
      headers: { cookie: "cust_session=" + session.accessToken },
    });
    await expect(validateWorkspaceManager(request)).resolves.toMatchObject({
      userId: "user_workspace_test",
      tenantId: "tenant_manager_test",
      kind: "customer",
    });
  });

  it("rejects a token signed with a different JWT header", async () => {
    const created = await createManagerSession("tenant_manager_test");
    const parts = created.token.split(".");
    const alteredHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const tampered = `${alteredHeader}.${parts[1]}.${parts[2]}`;
    await expect(verifyManagerToken(tampered)).resolves.toBeNull();
  });

  it("rejects a correctly signed token whose iat is too far in the future", async () => {
    const created = await createManagerSession("tenant_manager_test");
    const parts = created.token.split(".");
    const header = parts[0];
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    payload.iat += 3600;
    const mutatedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const data = `${header}.${mutatedPayload}`;
    const signature = createHmac("sha256", process.env.GATEWAY_JWT_SECRET!)
      .update(data)
      .digest("base64url");
    await expect(verifyManagerToken(`${data}.${signature}`)).resolves.toBeNull();
  });

  it("anchors v2 session creation and verification to PostgreSQL when the host clock is skewed", async () => {
    const dbNow = Number((await pool().query(
      "SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint AS now_sec",
    )).rows[0].now_sec);

    vi.useFakeTimers();
    vi.setSystemTime(new Date((dbNow + 24 * 60 * 60) * 1000));
    const created = await createManagerSession("tenant_manager_test");

    expect(Math.floor(created.exp.getTime() / 1000)).toBe(dbNow + 15 * 60);
    await expect(verifyManagerToken(created.token)).resolves.toMatchObject({ jti: created.jti });

    // v2 access JWTs are stateless; manager_sessions is the legacy-session
    // compatibility store and must not control v2 access-token expiry.
    vi.setSystemTime(new Date((dbNow - 24 * 60 * 60) * 1000));
    await expect(verifyManagerToken(created.token)).resolves.toMatchObject({ jti: created.jti });
  });

  it("accepts a valid scrypt password hash", async () => {
    const salt = "principal-audit-salt";
    const hash = scryptSync("correct-password", salt, 32).toString("hex");
    process.env.MANAGER_PASSWORD_HASH = `${salt}:${hash}`;
    await expect(verifyManagerPassword("manager", "correct-password")).resolves.toBe(true);
    await expect(verifyManagerPassword("manager", "wrong-password")).resolves.toBe(false);
  });

  it("rejects plaintext passwords in production", async () => {
    delete process.env.MANAGER_PASSWORD_HASH;
    process.env.MANAGER_PASSWORD = "plain-password";
    vi.stubEnv("NODE_ENV", "production");
    await expect(verifyManagerPassword("manager", "plain-password")).resolves.toBe(false);
  });
});