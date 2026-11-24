import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "../src/db";
import { users } from "../src/db/schema";
import { GET as statsGET } from "../src/app/api/platform/stats/route";
import { clearPlatformStatsCache } from "../src/lib/platform-stats-cache";
import { createVerifiedPlatformSession } from "./helpers/platform-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll } from "./helpers/pg";

describe("Platform stats live-owner source contract", () => {
  it("checks current owner authority before cached or fresh cross-tenant statistics", () => {
    const route = readFileSync("src/app/api/platform/stats/route.ts", "utf8");
    const guard = route.indexOf("requirePlatformReadAuthorityInTransaction(tx, actor)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(route.indexOf("getCachedPlatformStats(bypassCache)"));
    expect(route).toContain("return await db.transaction(async tx =>");
    expect(route).toContain("logicalUsageReport(null, tx)");
    expect(route).not.toContain("db.select(");
    expect(route).not.toContain("db.execute(");
  });
});

const suite = describe.skipIf(!hasTestDatabase);
suite("Platform stats current-session authorization during cross-tenant reads", () => {
  const ownerId = "platform-stats-race-owner";
  const email = "platform-stats-race-owner@example.test";
  let token: string;
  let previousSecret: string | undefined;

  beforeAll(async () => {
    previousSecret = process.env.GATEWAY_JWT_SECRET;
    process.env.GATEWAY_JWT_SECRET = "platform-stats-race-owner-test-secret-32";
    await applyMigrations();
  });
  beforeEach(async () => {
    clearPlatformStatsCache();
    await truncateAll();
    await seedFixture();
    await db.insert(users).values({
      id: ownerId, email, passwordHash: "verified-test-password-hash",
      emailVerifiedAt: new Date(), isPlatformOwner: true,
    });
    token = (await createVerifiedPlatformSession(ownerId, email)).token;
  });
  afterAll(async () => {
    if (previousSecret !== undefined) process.env.GATEWAY_JWT_SECRET = previousSecret;
    else delete process.env.GATEWAY_JWT_SECRET;
    await closePool();
  });

  const read = () => statsGET(new Request("http://localhost/api/platform/stats", {
    headers: { Authorization: "Bearer " + token, "cache-control": "no-cache" },
  }));

  it("returns the combined business/queue/usage snapshot to a live owner", async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      tenants: expect.objectContaining({ total: expect.any(Number) }),
      subscriptions: expect.any(Object), jobs24h: expect.any(Object),
      logicalUsage: expect.any(Object),
    });
  });

  it("does not release a confidential statistics snapshot after owner removal commits", async () => {
    const blocker = await pool().connect();
    let committed = false;
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE users SET is_platform_owner=false WHERE id=$1", [ownerId]);
      const pid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      pending = read();
      void pending.catch(() => undefined);
      await expect.poll(async () => {
        const x = await pool().query(
          "SELECT count(*)::int AS n FROM pg_stat_activity " +
          "WHERE datname=current_database() AND wait_event_type='Lock' " +
          "AND query LIKE '%FROM users%' AND query LIKE '%FOR SHARE%' " +
          "AND $1=ANY(pg_blocking_pids(pid))", [pid],
        );
        return Number(x.rows[0]?.n ?? 0);
      }, { timeout: 8_000, interval: 100 }).toBeGreaterThan(0);
      await blocker.query("COMMIT");
      committed = true;
      const response = await pending;
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const payload = await response.json();
      for (const key of ["tenants", "subscriptions", "jobs24h", "logicalUsage"]) {
        expect(payload).not.toHaveProperty(key);
      }
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
      await pending?.catch(() => undefined);
    }
  });
});
