import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_FAMILY_TTL_MS,
  REFRESH_ROTATION_GRACE_MS,
  hashRefreshToken,
  issueSessionPair,
  rotateRefreshToken,
  accessCookieHeader,
  refreshCookieHeader,
  verifyAccessTokenSignature,
} from "../src/lib/session-tokens";
import { validateManager } from "../src/lib/manager-auth";
import { validateCustomer } from "../src/lib/customer-auth";
import { applyMigrations, closePool, pool, truncateAll, hasTestDatabase } from "./helpers/pg";

const sentEmails: Array<{ to: string; subject: string }> = [];

vi.mock("../src/lib/email", () => ({
  sendTransactionalEmail: vi.fn(async (message: { to: string; subject: string }) => {
    sentEmails.push({ to: message.to, subject: message.subject });
  }),
}));

const suite = describe.skipIf(!hasTestDatabase);

suite("shared refresh-token session rotation", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "session-test-secret-32-characters-minimum";
    process.env.COOKIE_SECURE = "1";
    await applyMigrations();
  });

  beforeEach(async () => {
    sentEmails.length = 0;
    await truncateAll();
    await pool().query("INSERT INTO tenants (id, name) VALUES ($1, $2)", ["tenant_session_test", "Session Test Tenant"]);
    await pool().query(
      "INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, clock_timestamp())",
      ["user_session_test", "session@example.test", "unused"],
    );
    await pool().query(
      "INSERT INTO tenant_users (user_id, tenant_id, role) VALUES ($1, $2, $3)",
      ["user_session_test", "tenant_session_test", "admin"],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it("keeps manager and customer v2 access-token kinds isolated", async () => {
    const customer = await issueSessionPair({
      kind: "customer",
      tenantId: "tenant_session_test",
      userId: "user_session_test",
      role: "admin",
      email: "session@example.test",
    });

    const request = new Request("http://gateway.test/api/auth/me", {
      headers: { cookie: "mgr_session=" + customer.accessToken },
    });

    const payload = JSON.parse(Buffer.from(customer.accessToken.split(".")[1], "base64url").toString("utf8")) as {
      ver?: unknown;
      kind?: unknown;
      sub?: unknown;
    };
    expect(payload.ver).toBe(2);
    expect(payload.kind).toBe("customer");
    expect(payload.sub).toBe("manager");
    expect(verifyAccessTokenSignature(customer.accessToken, "manager")).toBeNull();

    const managerClaims = await validateManager(request);
    expect(managerClaims).toBeNull();

    const customerPair = await issueSessionPair({
      kind: "manager",
      tenantId: "tenant_session_test",
      userId: "user_session_test",
      role: "admin",
      email: "session@example.test",
    });
    const managerCookieCustomerToken = await validateCustomer(request);
    expect(managerCookieCustomerToken).toBeNull();

    const customerRequest = new Request("http://gateway.test/api/auth/me", {
      headers: { cookie: "cust_session=" + customer.accessToken },
    });
    const customerClaims = await validateCustomer(customerRequest);
    expect(customerClaims).not.toBeNull();
    expect(customerClaims?.kind).toBe("customer");
    expect(customerClaims?.tenantId).toBe("tenant_session_test");

    const customerTokenInManagerCookie = await validateManager(new Request("http://gateway.test/api/agents", {
      headers: { cookie: "mgr_session=" + customer.accessToken },
    }));
    expect(customerTokenInManagerCookie).toBeNull();
  });

  it("issues a 15-minute access token and hashed 30-day refresh family", async () => {
    const pair = await issueSessionPair({
      kind: "manager",
      tenantId: "tenant_session_test",
      userId: "user_session_test",
      role: "admin",
      email: "session@example.test",
    }, {
      ipAddress: "198.51.100.20",
      userAgent: "session-test",
    });

    expect(pair.accessExpiresAt.getTime() - pair.refreshExpiresAt.getTime()).toBeLessThan(0);
    expect(pair.accessExpiresAt.getTime()).toBeLessThan(pair.refreshExpiresAt.getTime());
    expect(pair.accessJti).not.toBe(pair.refreshTokenId);
    expect(pair.refreshToken.length).toBeGreaterThan(40);

    const row = (await pool().query(
      "SELECT id, family_id, kind, tenant_id, user_id, role, email, token_hash, issued_at, family_created_at, expires_at, ip_address, user_agent FROM refresh_tokens WHERE id = $1",
      [pair.refreshTokenId],
    )).rows[0];

    expect(row.kind).toBe("manager");
    expect(row.family_id).toBe(pair.familyId);
    expect(row.tenant_id).toBe("tenant_session_test");
    expect(row.user_id).toBe("user_session_test");
    expect(row.role).toBe("admin");
    expect(row.email).toBe("session@example.test");
    expect(row.token_hash).toBe(hashRefreshToken(pair.refreshToken));
    expect(row.token_hash).not.toBe(pair.refreshToken);
    const accessLifetimeMs = Number(pair.accessExpiresAt) - Number(row.issued_at);
    expect(accessLifetimeMs).toBeGreaterThanOrEqual((ACCESS_TOKEN_TTL_SECONDS * 1000) - 1000);
    expect(accessLifetimeMs).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_SECONDS * 1000);
    expect(Number(row.expires_at) - Number(row.family_created_at)).toBe(REFRESH_FAMILY_TTL_MS);
    expect(row.ip_address).toBe("198.51.100.20");
    expect(row.user_agent).toBe("session-test");
  });

  it("rejects refresh after tenant membership is removed and revokes the family", async () => {
    const first = await issueSessionPair({
      kind: "customer",
      tenantId: "tenant_session_test",
      userId: "user_session_test",
      role: "admin",
      email: "session@example.test",
    });

    await pool().query(
      "DELETE FROM tenant_users WHERE user_id = $1 AND tenant_id = $2",
      ["user_session_test", "tenant_session_test"],
    );

    const rotated = await rotateRefreshToken("customer", first.refreshToken);
    expect(rotated.status).toBe("invalid");

    const row = (await pool().query(
      "SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE family_id = $1",
      [first.familyId],
    )).rows[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("principal_invalid");
  });

  it("rotates normally and keeps the family absolute expiry fixed", async () => {
    const first = await issueSessionPair({
      kind: "manager",
      tenantId: "tenant_session_test",
      userId: "user_session_test",
      role: "admin",
      email: "session@example.test",
    });

    const rotated = await rotateRefreshToken("manager", first.refreshToken, {
      ipAddress: "198.51.100.21",
      userAgent: "rotated-client",
    });

    expect(rotated.status).toBe("rotated");
    if (rotated.status !== "rotated") return;
    expect(rotated.pair.familyId).toBe(first.familyId);
    expect(rotated.pair.refreshToken).not.toBe(first.refreshToken);

    const rows = (await pool().query(
      "SELECT id, family_id, replaced_by, replaced_at, expires_at FROM refresh_tokens WHERE family_id = $1 ORDER BY issued_at",
      [first.familyId],
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].replaced_by).toBe(rotated.pair.refreshTokenId);
    expect(rows[0].replaced_at).not.toBeNull();
    expect(rows[0].expires_at).toEqual(rows[1].expires_at);
  });

  it("accepts the replaced refresh token inside the 5-second grace window", async () => {
    const first = await issueSessionPair({
      kind: "manager",
      tenantId: "tenant_session_test",
      userId: "user_session_test",
      role: "admin",
      email: "session@example.test",
    });

    const firstRotation = await rotateRefreshToken("manager", first.refreshToken, {
      ipAddress: "198.51.100.22",
      userAgent: "grace-a",
    });
    expect(firstRotation.status).toBe("rotated");

    const secondRotation = await rotateRefreshToken("manager", first.refreshToken, {
      ipAddress: "198.51.100.22",
      userAgent: "grace-b",
    });
    expect(secondRotation.status).toBe("rotated");
    if (secondRotation.status !== "rotated") return;

    const active = (await pool().query(
      "SELECT count(*)::int AS count FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL",
      [first.familyId],
    )).rows[0].count;
    expect(Number(active)).toBeGreaterThanOrEqual(2);
    expect(REFRESH_ROTATION_GRACE_MS).toBe(5_000);
  });

  it("treats an old refresh token after grace as family reuse and sends a security notification", async () => {
    const first = await issueSessionPair({
      kind: "manager",
      tenantId: "tenant_session_test",
      userId: "user_session_test",
      role: "admin",
      email: "session@example.test",
    });

    const rotated = await rotateRefreshToken("manager", first.refreshToken, {
      ipAddress: "198.51.100.23",
      userAgent: "replay-source",
    });
    expect(rotated.status).toBe("rotated");

    await pool().query(
      "UPDATE refresh_tokens SET replaced_at = clock_timestamp() - interval '6 seconds' WHERE id = $1",
      [first.refreshTokenId],
    );

    const replay = await rotateRefreshToken("manager", first.refreshToken, {
      ipAddress: "198.51.100.24",
      userAgent: "replay-source",
    });

    expect(replay.status).toBe("reused");
    expect(sentEmails).toEqual([
      {
        to: "session@example.test",
        subject: "Yasser security alert: refresh token reuse detected",
      },
    ]);

    const family = await pool().query(
      "SELECT id, revoked_at, revoked_reason, replaced_by FROM refresh_tokens WHERE family_id = $1 ORDER BY issued_at",
      [first.familyId],
    );
    expect(family.rows.length).toBeGreaterThanOrEqual(2);
    expect(family.rows.every((row) => row.revoked_at !== null)).toBe(true);
    expect(family.rows.every((row) => row.revoked_reason === "refresh_reuse_detected")).toBe(true);

    const audit = await pool().query(
      "SELECT action, resource_type, resource_id FROM audit_events WHERE action = $1 AND resource_id = $2",
      ["auth.refresh.reuse_detected", first.familyId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].resource_type).toBe("refresh_token_family");
  });

  it("uses SameSite=Strict for refresh cookies and keeps the access cookie on Lax", () => {
    const refresh = refreshCookieHeader("manager", "opaque-refresh-secret", new Date("2026-10-25T00:00:00.000Z"));
    expect(refresh).toContain("HttpOnly");
    expect(refresh).toContain("SameSite=Strict");
    expect(refresh).toContain("Secure");

    const access = accessCookieHeader("manager", "opaque-access-token", new Date("2026-09-25T00:15:00.000Z"));
    expect(access).toContain("HttpOnly");
    expect(access).toContain("SameSite=Lax");
    expect(access).toContain("Secure");
  });
});
