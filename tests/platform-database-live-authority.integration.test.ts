import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { users } from "../src/db/schema";
import { GET as databaseGET } from "../src/app/api/platform/database/route";
import { createVerifiedPlatformSession } from "./helpers/platform-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);
suite("Platform database explorer private catalog revocation fence", () => {
  const ownerId = "platform-explorer-live-owner";
  const email = "explorer-live-owner@example.test";
  let token: string;
  let previousSecret: string | undefined;
  beforeAll(async () => {
    previousSecret = process.env.GATEWAY_JWT_SECRET;
    process.env.GATEWAY_JWT_SECRET = "platform-explorer-owner-test-secret-32";
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedFixture();
    await db.insert(users).values({
      id: ownerId, email, passwordHash: "verified-test-password-hash",
      emailVerifiedAt: new Date(), isPlatformOwner: true,
    });
    token = (await createVerifiedPlatformSession(ownerId,email)).token;
  });
  afterAll(async () => {
    if (previousSecret !== undefined) process.env.GATEWAY_JWT_SECRET = previousSecret;
    else delete process.env.GATEWAY_JWT_SECRET;
    await closePool();
  });
  const read = () => databaseGET(new Request("http://localhost/api/platform/database?table=printers&offset=0", {
    headers: { Authorization: "Bearer " + token },
  }));

  it("returns a bounded read-only catalog to a current Platform Owner", async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ selected: "printers", columns: expect.any(Array), rows: expect.any(Array) });
  });

  it("never returns catalog rows after owner removal commits during pre-read guard wait", async () => {
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
      expect(payload).not.toHaveProperty("rows");
      expect(payload).not.toHaveProperty("tables");
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
      await pending?.catch(() => undefined);
    }
  });
});
