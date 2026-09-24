import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  insertQueuedJob,
  closePool,
  type Fixture,
} from "./helpers/pg";
import { users, tenantSubscriptions } from "../src/db/schema";
import { db } from "../src/db";
import { eq } from "drizzle-orm";
import { nanoid } from "../src/lib/nanoid";
import { createPlatformSession } from "../src/lib/platform-auth";
import { GET } from "../src/app/api/platform/stats/route";

const suite = describe.skipIf(!hasTestDatabase);

let prevSecret: string | undefined;
let fixture: Fixture;
let platformToken = "";

suite("Platform Stats Route", () => {
  beforeAll(async () => {
    prevSecret = process.env.GATEWAY_JWT_SECRET;
    process.env.GATEWAY_JWT_SECRET = "x".repeat(40);
    await applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();

    const userId = `usr_${nanoid(18)}`;
    const email = `platform_${nanoid(8)}@platform.local`;
    await db.insert(users).values({
      id: userId,
      email,
      passwordHash: "unused-in-route-test",
      isPlatformOwner: true,
      emailVerifiedAt: new Date(),
    });
    const session = await createPlatformSession(userId, email);
    platformToken = session.token;
  });

  afterAll(async () => {
    if (prevSecret !== undefined) process.env.GATEWAY_JWT_SECRET = prevSecret;
    else delete process.env.GATEWAY_JWT_SECRET;
    await closePool();
  });

  it("executes all subscription lifecycle aggregates, including incomplete states", async () => {
    await db.update(tenantSubscriptions)
      .set({ status: "incomplete" })
      .where(eq(tenantSubscriptions.tenantId, fixture.tenantId));

    await insertQueuedJob(fixture, `job_${nanoid(10)}`);

    const response = await GET(new Request("http://localhost/api/platform/stats", {
      headers: { Authorization: `Bearer ${platformToken}` },
    }));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.subscriptions).toMatchObject({
      total: 1,
      active: 0,
      trialing: 0,
      pastDue: 0,
      incomplete: 1,
      incompleteExpired: 0,
      unpaid: 0,
      paused: 0,
      cancelled: 0,
      attention: 1,
    });
    expect(body.jobs24h.total).toBe(1);
    expect(body.jobs24hHourly).toHaveLength(25);
    expect(body.jobs24hHourly.some((row: { total: number; queued: number }) => row.total === 1 && row.queued === 1)).toBe(true);
  });
});
