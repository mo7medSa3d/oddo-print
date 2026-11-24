/** DB-backed session lifecycle for the v5-auth renewal work.
 *
 * Uses the REAL session implementation (issue + rotateRefreshTokenDetailed
 * against scratch PostgreSQL) — no mocks of the auth system. The email
 * module is stubbed only to capture the reuse notification, exactly like
 * tests/session-tokens.integration.test.ts. Login, registration, email
 * verification, password reset and manager login keep their existing suites
 * and are run as regressions, not duplicated here.
 *
 * Timestamp manipulation is used, and it simulates time rather than
 * mocking logic: setting a replaced token's replaced_at 10 s in the past
 * stands in for the 5 s grace window having elapsed, so the reuse detector
 * can be exercised without a 5 s wall-clock wait. The same applies to the
 * idle test, where the policy row's clock (created_at, password_verified_at
 * and last_seen_at together, preserving the table's created_at <=
 * last_seen_at ordering check) is moved 31 min into the past.
 */
import { issueWorkspaceTestSession } from "./helpers/workspace-session";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import {
  refreshFailureCode,
  rotateRefreshTokenDetailed,
} from "../src/lib/session-tokens";
import { applyMigrations, closePool, pool, truncateAll, hasTestDatabase } from "./helpers/pg";

const sentEmails: Array<{ to: string; subject: string }> = [];

vi.mock("../src/lib/email", () => ({
  sendTransactionalEmail: vi.fn(async (message: { to: string; subject: string }) => {
    sentEmails.push({ to: message.to, subject: message.subject });
  }),
}));

const suite = describe.skipIf(!hasTestDatabase);

async function seedTenant(tenantId: string, userId: string, email: string) {
  await pool().query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `Tenant ${tenantId}`]);
  await pool().query(
    "INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, clock_timestamp())",
    [userId, email, "unused"],
  );
  await pool().query("INSERT INTO tenant_users (user_id, tenant_id, role) VALUES ($1, $2, $3)", [userId, tenantId, "admin"]);
}

async function issue(tenantId: string, userId: string, email: string) {
  return issueWorkspaceTestSession({ kind: "customer", tenantId, userId, role: "admin", email });
}

async function liveRows(familyId: string) {
  const result = await pool().query(
    "SELECT id, revoked_at, replaced_by, revoked_reason FROM refresh_tokens WHERE family_id = $1",
    [familyId],
  );
  return result.rows as Array<{ id: string; revoked_at: Date | null; replaced_by: string | null; revoked_reason: string | null }>;
}

suite("session renewal lifecycle (real rotation)", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "session-test-secret-32-characters-minimum";
    process.env.COOKIE_SECURE = "1";
    await applyMigrations();
  });

  beforeEach(async () => {
    sentEmails.length = 0;
    await truncateAll();
    await seedTenant("tenant_renew_a", "user_renew_a", "a@renewal.test");
    await seedTenant("tenant_renew_b", "user_renew_b", "b@renewal.test");
  });

  afterAll(async () => {
    await closePool();
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it("silent renewal rotates, keeps the old token in its grace window, and supersedes the first successor without killing the family", async () => {
    const initial = await issue("tenant_renew_a", "user_renew_a", "a@renewal.test");
    const first = await rotateRefreshTokenDetailed("customer", initial.refreshToken);
    expect(first.status).toBe("rotated");
    if (first.status !== "rotated") throw new Error("expected rotation");
    expect(first.pair.familyId).toBe(initial.familyId);
    expect(first.pair.refreshToken).not.toBe(initial.refreshToken);
    // Within the 5 s grace window the old token rotates again…
    const graced = await rotateRefreshTokenDetailed("customer", initial.refreshToken);
    expect(graced.status).toBe("rotated");
    if (graced.status !== "rotated") throw new Error("expected grace rotation");
    expect(graced.pair.refreshToken).not.toBe(first.pair.refreshToken);
    // …and the first successor is now revoked, while the newest token lives.
    const deadSuccessor = await rotateRefreshTokenDetailed("customer", first.pair.refreshToken);
    expect(deadSuccessor.status).toBe("invalid");
    expect(refreshFailureCode(deadSuccessor)).toBe("REFRESH_TOKEN_REVOKED");
    const latest = await rotateRefreshTokenDetailed("customer", graced.pair.refreshToken);
    expect(latest.status).toBe("rotated");
  });

  it("invalid tokens and wrong-kind presentations are rejected without side effects", async () => {
    const initial = await issue("tenant_renew_a", "user_renew_a", "a@renewal.test");
    const garbage = await rotateRefreshTokenDetailed("customer", "not-a-real-refresh-token");
    expect(garbage.status).toBe("invalid");
    expect(refreshFailureCode(garbage)).toBe("REFRESH_TOKEN_INVALID");
    const wrongKind = await rotateRefreshTokenDetailed("manager", initial.refreshToken);
    expect(wrongKind.status).toBe("invalid");
    expect(refreshFailureCode(wrongKind)).toBe("REFRESH_TOKEN_INVALID");
    // The untouched family still renews afterwards.
    const ok = await rotateRefreshTokenDetailed("customer", initial.refreshToken);
    expect(ok.status).toBe("rotated");
  });

  it("reuse after the grace window revokes the whole family and the successor can no longer renew", async () => {
    const initial = await issue("tenant_renew_a", "user_renew_a", "a@renewal.test");
    const first = await rotateRefreshTokenDetailed("customer", initial.refreshToken);
    expect(first.status).toBe("rotated");
    if (first.status !== "rotated") throw new Error("expected rotation");
    // Simulate the grace window having elapsed (see file header).
    await pool().query(
      "UPDATE refresh_tokens SET replaced_at = clock_timestamp() - interval '10 seconds' WHERE id = $1",
      [initial.refreshTokenId],
    );
    const reuse = await rotateRefreshTokenDetailed("customer", initial.refreshToken);
    expect(reuse.status).toBe("reused");
    expect(refreshFailureCode(reuse)).toBe("REFRESH_TOKEN_REUSED");
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe("a@renewal.test");
    const deadSuccessor = await rotateRefreshTokenDetailed("customer", first.pair.refreshToken);
    expect(deadSuccessor.status).toBe("invalid");
    expect(refreshFailureCode(deadSuccessor)).toBe("REFRESH_TOKEN_REUSED");
    const rows = await liveRows(initial.familyId);
    expect(rows.every(row => row.revoked_at !== null)).toBe(true);
  });

  it("concurrent rotations of one token do not fork the family or invalidate the legitimate session", async () => {
    const initial = await issue("tenant_renew_a", "user_renew_a", "a@renewal.test");
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => rotateRefreshTokenDetailed("customer", initial.refreshToken)),
    );
    expect(outcomes.every(outcome => outcome.status === "rotated")).toBe(true);
    const rows = await liveRows(initial.familyId);
    expect(rows).toHaveLength(6);
    const live = rows.filter(row => row.revoked_at === null && row.replaced_by === null);
    expect(live).toHaveLength(1);
    expect(rows.some(row => row.revoked_reason === "refresh_reuse_detected")).toBe(false);
    // The surviving token still renews: concurrency never killed the session.
    // Promise.all preserves input order, NOT completion order, so the
    // survivor is resolved from the live DB row, not from outcomes.at(-1):
    // an earlier-finishing rotation's token may since have been superseded.
    const rotatedPairs = outcomes.filter(outcome => outcome.status === "rotated");
    const survivor = rotatedPairs.find(outcome => outcome.status === "rotated" && outcome.pair.refreshTokenId === live[0].id);
    if (!survivor || survivor.status !== "rotated") throw new Error("expected the live row to match one rotated pair");
    const again = await rotateRefreshTokenDetailed("customer", survivor.pair.refreshToken);
    expect(again.status).toBe("rotated");
  });

  it("a tenant A token cannot mint a tenant B session and leaves the B family untouched", async () => {
    const a = await issue("tenant_renew_a", "user_renew_a", "a@renewal.test");
    const b = await issue("tenant_renew_b", "user_renew_b", "b@renewal.test");
    expect(a.familyId).not.toBe(b.familyId);
    const rotatedA = await rotateRefreshTokenDetailed("customer", a.refreshToken);
    expect(rotatedA.status).toBe("rotated");
    if (rotatedA.status !== "rotated") throw new Error("expected rotation");
    expect(rotatedA.pair.familyId).toBe(a.familyId);
    // B's original token still renews its own family afterwards.
    const rotatedB = await rotateRefreshTokenDetailed("customer", b.refreshToken);
    expect(rotatedB.status).toBe("rotated");
    if (rotatedB.status !== "rotated") throw new Error("expected rotation");
    expect(rotatedB.pair.familyId).toBe(b.familyId);
    // And A's newest token is likewise unaffected by B's rotation.
    const againA = await rotateRefreshTokenDetailed("customer", rotatedA.pair.refreshToken);
    expect(againA.status).toBe("rotated");
  });

  it("an idle session refresh reports SESSION_IDLE_EXPIRED, kills the family, and the dead session stays dead", async () => {
    const initial = await issue("tenant_renew_a", "user_renew_a", "a@renewal.test");
    await pool().query(
      "UPDATE workspace_session_security SET created_at = clock_timestamp() - interval '31 minutes', password_verified_at = clock_timestamp() - interval '31 minutes', last_seen_at = clock_timestamp() - interval '31 minutes' WHERE family_id = $1",
      [initial.familyId],
    );
    const idle = await rotateRefreshTokenDetailed("customer", initial.refreshToken);
    expect(idle.status).toBe("invalid");
    expect(refreshFailureCode(idle)).toBe("SESSION_IDLE_EXPIRED");
    const again = await rotateRefreshTokenDetailed("customer", initial.refreshToken);
    expect(again.status).toBe("invalid");
    expect(refreshFailureCode(again)).toBe("WORKSPACE_SESSION_EXPIRED");
  });
});
