import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { issueSessionPair, rotateRefreshToken } from "../src/lib/session-tokens";
import { POST as managerLogout } from "../src/app/api/auth/manager/logout/route";
import { POST as customerLogout } from "../src/app/api/auth/logout/route";
import { POST as platformLogout } from "../src/app/api/platform/auth/logout/route";
import { applyMigrations, closePool, pool, truncateAll, hasTestDatabase } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

function requestWithCookie(name: string, value: string): Request {
  return new Request("http://gateway.test/logout", {
    method: "POST",
    headers: { cookie: name + "=" + value },
  });
}

suite("refresh-family logout", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "session-logout-test-secret-32-characters";
    await applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    await pool().query("INSERT INTO tenants (id, name) VALUES ($1, $2)", ["tenant_logout_test", "Logout Test Tenant"]);
    await pool().query(
      "INSERT INTO users (id, email, password_hash, email_verified_at, is_platform_owner) VALUES ($1, $2, $3, clock_timestamp(), $4)",
      ["user_logout_test", "logout@example.test", "unused", false],
    );
    await pool().query(
      "INSERT INTO tenant_users (user_id, tenant_id, role) VALUES ($1, $2, $3)",
      ["user_logout_test", "tenant_logout_test", "admin"],
    );
    await pool().query(
      "INSERT INTO users (id, email, password_hash, email_verified_at, is_platform_owner) VALUES ($1, $2, $3, clock_timestamp(), true)",
      ["platform_logout_test", "platform-logout@example.test", "unused"],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it("manager logout revokes the entire refresh family", async () => {
    const first = await issueSessionPair({
      kind: "manager",
      tenantId: "tenant_logout_test",
      userId: "user_logout_test",
      role: "admin",
      email: "logout@example.test",
    });
    const second = await rotateRefreshToken("manager", first.refreshToken);
    expect(second.status).toBe("rotated");

    const response = await managerLogout(requestWithCookie("mgr_session", first.accessToken));
    expect(response.status).toBe(200);

    const rows = await pool().query(
      "SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE family_id = $1",
      [first.familyId],
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.every((row) => row.revoked_at !== null && row.revoked_reason === "logout")).toBe(true);
  });

  it("customer logout revokes the family using only the refresh cookie", async () => {
    const first = await issueSessionPair({
      kind: "customer",
      tenantId: "tenant_logout_test",
      userId: "user_logout_test",
      role: "admin",
      email: "logout@example.test",
    });

    const second = await rotateRefreshToken("customer", first.refreshToken);
    expect(second.status).toBe("rotated");
    if (second.status !== "rotated") return;

    const response = await customerLogout(
      requestWithCookie("cust_refresh", second.pair.refreshToken),
    );
    expect(response.status).toBe(200);

    const rows = await pool().query(
      "SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE family_id = $1",
      [first.familyId],
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.every((row) => row.revoked_at !== null && row.revoked_reason === "logout")).toBe(true);
  });

  it("customer logout revokes the entire customer refresh family", async () => {
    const first = await issueSessionPair({
      kind: "customer",
      tenantId: "tenant_logout_test",
      userId: "user_logout_test",
      role: "admin",
      email: "logout@example.test",
    });
    const second = await rotateRefreshToken("customer", first.refreshToken);
    expect(second.status).toBe("rotated");

    const response = await customerLogout(requestWithCookie("cust_session", first.accessToken));
    expect(response.status).toBe(200);

    const rows = await pool().query(
      "SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE family_id = $1",
      [first.familyId],
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.every((row) => row.revoked_at !== null && row.revoked_reason === "logout")).toBe(true);
  });

  it("platform logout revokes the entire platform refresh family", async () => {
    const first = await issueSessionPair({
      kind: "platform",
      userId: "platform_logout_test",
      email: "platform-logout@example.test",
      tenantId: null,
      role: null,
    });
    const second = await rotateRefreshToken("platform", first.refreshToken);
    expect(second.status).toBe("rotated");

    const response = await platformLogout(requestWithCookie("plt_session", first.accessToken));
    expect(response.status).toBe(200);

    const rows = await pool().query(
      "SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE family_id = $1",
      [first.familyId],
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.every((row) => row.revoked_at !== null && row.revoked_reason === "logout")).toBe(true);
  });
});
