import { gatewayTestSigningKey } from "./helpers/test-secrets";
import { createHmac } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { LEGACY_SESSION_MAX_AGE_SECONDS } from "../src/lib/session-config";
import {
  createPlatformSession,
  verifyPlatformTokenSignature,
  validatePlatformClaims,
  requirePlatformOwner,
  PlatformUnauthorizedError,
  authenticatePlatformOwner,
  revokePlatformSession,
} from "../src/lib/platform-auth";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  closePool,
  type Fixture,
} from "./helpers/pg";
import { users, auditEvents } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { hashPassword, normalizeEmail } from "../src/lib/password";
import { nanoid } from "../src/lib/nanoid";
import { writeAuditEvent } from "../src/lib/audit";

const suite = describe.skipIf(!hasTestDatabase);

let prevSecret: string | undefined;
let fixture: Fixture;

suite("Platform Control Plane & Authorization Boundaries", () => {
  beforeAll(async () => {
    prevSecret = process.env.GATEWAY_JWT_SECRET;
    process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey();
    await applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
  });

  afterAll(async () => {
    if (prevSecret !== undefined) {
      process.env.GATEWAY_JWT_SECRET = prevSecret;
    } else {
      delete process.env.GATEWAY_JWT_SECRET;
    }
    await closePool();
  });

  async function createTestUser(opts?: { isPlatformOwner?: boolean; verified?: boolean }) {
    const userId = `usr_${nanoid(18)}`;
    const email = normalizeEmail(`test_${nanoid(8)}@platform.local`);
    const password = "SecurePassword123!";
    const passwordHash = await hashPassword(password);
    const now = new Date();

    await db.insert(users).values({
      id: userId,
      email,
      passwordHash,
      isPlatformOwner: opts?.isPlatformOwner ?? false,
      emailVerifiedAt: opts?.verified !== false ? now : null,
    });

    return { userId, email, password };
  }

  it("verifies platform token signature and claims structure", async () => {
    const user = await createTestUser({ isPlatformOwner: true });
    const session = await createPlatformSession(user.userId, user.email);

    expect(session.token).toBeTypeOf("string");
    expect(session.jti).toBeTypeOf("string");

    const claims = verifyPlatformTokenSignature(session.token);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("platform_owner");
    expect(claims?.userId).toBe(user.userId);
    expect(claims?.email).toBe(user.email);
  });

  it("refuses platform claims for users where is_platform_owner is false", async () => {
    const user = await createTestUser({ isPlatformOwner: false });
    const session = await createPlatformSession(user.userId, user.email);
    const validated = await validatePlatformClaims(verifyPlatformTokenSignature(session.token));
    expect(validated).toBeNull();
  });

  it("validates platform claims when is_platform_owner is true and email is verified", async () => {
    const user = await createTestUser({ isPlatformOwner: true });
    const session = await createPlatformSession(user.userId, user.email);
    const validated = await validatePlatformClaims(verifyPlatformTokenSignature(session.token));

    expect(validated).not.toBeNull();
    expect(validated?.userId).toBe(user.userId);
    expect(validated?.sub).toBe("platform_owner");
  });

  it("authenticates platform owner via email/password credential", async () => {
    const user = await createTestUser({ isPlatformOwner: true });

    const authResult = await authenticatePlatformOwner(user.email, user.password);
    expect(authResult).not.toBeNull();
    expect(authResult?.userId).toBe(user.userId);

    const invalidAuth = await authenticatePlatformOwner(user.email, "WrongPassword");
    expect(invalidAuth).toBeNull();
  });

  it("rejects a v2 access token immediately after its refresh family is revoked", async () => {
    const user = await createTestUser({ isPlatformOwner: true });
    const session = await createPlatformSession(user.userId, user.email);

    expect(await validatePlatformClaims(verifyPlatformTokenSignature(session.token))).not.toBeNull();

    await db.execute(sql`
      UPDATE refresh_tokens
      SET revoked_at = clock_timestamp(), revoked_reason = 'logout'
      WHERE family_id = ${session.familyId}
        AND kind = 'platform'
    `);

    expect(await validatePlatformClaims(verifyPlatformTokenSignature(session.token))).toBeNull();
  });

  it("revokes legacy platform session and invalidates legacy claims", async () => {
    const user = await createTestUser({ isPlatformOwner: true });
    const jti = `legacy_platform_${nanoid(18)}`;
    await db.execute(sql`
      INSERT INTO platform_sessions (jti, user_id, expires_at)
      VALUES (${jti}, ${user.userId}, clock_timestamp() + interval '8 hours')
    `);
    const createdAt = Number((await db.execute(
      sql`SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint AS now_sec`,
    )).rows[0]?.now_sec);
    const legacyHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const legacyPayload = Buffer.from(JSON.stringify({
      jti,
      iat: createdAt,
      exp: createdAt + LEGACY_SESSION_MAX_AGE_SECONDS,
      sub: "platform_owner",
      userId: user.userId,
      email: user.email,
    })).toString("base64url");
    const data = `${legacyHeader}.${legacyPayload}`;
    const signature = createHmac("sha256", process.env.GATEWAY_JWT_SECRET!).update(data).digest("base64url");
    const token = `${data}.${signature}`;

    let validated = await validatePlatformClaims(verifyPlatformTokenSignature(token));
    expect(validated).not.toBeNull();

    await revokePlatformSession(jti);
    validated = await validatePlatformClaims(verifyPlatformTokenSignature(token));
    expect(validated).toBeNull();
  });

  it("enforces single platform owner database unique constraint", async () => {
    await createTestUser({ isPlatformOwner: true });
    // Attempting to create a second user with isPlatformOwner = true must throw DB unique index error
    await expect(createTestUser({ isPlatformOwner: true })).rejects.toThrow();
  });

  it("requires platform owner guard and throws PlatformUnauthorizedError on invalid request", async () => {
    const fakeReq = new Request("http://localhost/api/platform/stats");
    await expect(requirePlatformOwner(fakeReq)).rejects.toThrow(PlatformUnauthorizedError);
  });

  it("preserves regular users as tenant-scoped without granting platform owner status", async () => {
    const user = await createTestUser({ isPlatformOwner: false });
    const userRow = await db.query.users.findFirst({ where: eq(users.id, user.userId) });
    expect(userRow?.isPlatformOwner).toBe(false);
  });

  it("allows platform-scoped audit events with tenantId = null", async () => {
    const user = await createTestUser({ isPlatformOwner: true });
    await expect(
      writeAuditEvent({
        tenantId: null,
        actorType: "platform",
        actorId: user.userId,
        action: "platform.bootstrap",
        resourceType: "platform_owner",
        resourceId: user.userId,
      })
    ).resolves.not.toThrow();

    await expect(
      writeAuditEvent({
        tenantId: null,
        actorType: "platform",
        actorId: user.userId,
        action: "platform.login",
        resourceType: "platform_owner",
        resourceId: user.userId,
      })
    ).resolves.not.toThrow();

    await expect(
      writeAuditEvent({
        tenantId: null,
        actorType: "platform",
        actorId: user.userId,
        action: "platform.logout",
        resourceType: "platform_owner",
        resourceId: user.userId,
      })
    ).resolves.not.toThrow();
  });

  it("enforces database CHECK constraint that non-platform actors require a valid tenantId", async () => {
    // Attempting to insert a non-platform actor with tenantId: null must violate audit_events_scope_check
    await expect(
      db.insert(auditEvents).values({
        id: `audit_${nanoid(14)}`,
        tenantId: null,
        actorType: "user",
        actorId: "usr_test",
        action: "user.login.success",
      })
    ).rejects.toThrow();
  });

  it("allows platform actors to write tenant-scoped audit events on a real tenant", async () => {
    const user = await createTestUser({ isPlatformOwner: true });
    await expect(
      writeAuditEvent({
        tenantId: fixture.tenantId,
        actorType: "platform",
        actorId: user.userId,
        action: "tenant.suspended",
        resourceType: "tenant",
        resourceId: fixture.tenantId,
        metadata: { reason: "Policy violation" },
      })
    ).resolves.not.toThrow();
  });
});
