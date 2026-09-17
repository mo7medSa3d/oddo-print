import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  createPlatformSession,
  verifyPlatformToken,
  validatePlatformClaims,
  requirePlatformOwner,
  PlatformUnauthorizedError,
  authenticatePlatformOwner,
} from "../src/lib/platform-auth";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  closePool,
} from "./helpers/pg";
import { users } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { hashPassword } from "../src/lib/password";
import { nanoid } from "../src/lib/nanoid";

const suite = describe.skipIf(!hasTestDatabase);

suite("Platform Control Plane & Authorization Boundaries", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    await seedFixture();
  });

  afterAll(async () => {
    await closePool();
  });

  async function createTestUser(opts?: { isPlatformOwner?: boolean; verified?: boolean }) {
    const userId = `usr_${nanoid(18)}`;
    const email = `test_${nanoid(8)}@platform.local`;
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

    const claims = verifyPlatformToken(session.token);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("platform_owner");
    expect(claims?.userId).toBe(user.userId);
    expect(claims?.email).toBe(user.email);
  });

  it("refuses platform claims for users where is_platform_owner is false", async () => {
    const user = await createTestUser({ isPlatformOwner: false });
    const session = await createPlatformSession(user.userId, user.email);
    const validated = await validatePlatformClaims(verifyPlatformToken(session.token));
    expect(validated).toBeNull();
  });

  it("validates platform claims when is_platform_owner is true and email is verified", async () => {
    const user = await createTestUser({ isPlatformOwner: true });
    const session = await createPlatformSession(user.userId, user.email);
    const validated = await validatePlatformClaims(verifyPlatformToken(session.token));

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

  it("requires platform owner guard and throws PlatformUnauthorizedError on invalid request", async () => {
    const fakeReq = new Request("http://localhost/api/platform/stats");
    await expect(requirePlatformOwner(fakeReq)).rejects.toThrow(PlatformUnauthorizedError);
  });

  it("preserves regular users as tenant-scoped without granting platform owner status", async () => {
    const user = await createTestUser({ isPlatformOwner: false });
    const userRow = await db.query.users.findFirst({ where: eq(users.id, user.userId) });
    expect(userRow?.isPlatformOwner).toBe(false);
  });
});
