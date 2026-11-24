import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "../src/db";
import { users } from "../src/db/schema";
import { GET as platformGET } from "../src/app/api/platform/auth/sessions/route";
import { GET as workspaceGET } from "../src/app/api/auth/sessions/route";
import { createVerifiedPlatformSession } from "./helpers/platform-session";
import { createWorkspaceManagerTestSession } from "./helpers/workspace-session";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll } from "./helpers/pg";

describe("Session directory read-transaction contracts", () => {
  it("keeps account and live-family selectors in the caller's guarded transaction", () => {
    const session = readFileSync("src/lib/session-inventory.ts","utf8");
    const platform = readFileSync("src/app/api/platform/auth/sessions/route.ts","utf8");
    const workspace = readFileSync("src/app/api/auth/sessions/route.ts","utf8");
    expect(session).toContain("tx ? await tx.execute(accountQuery)");
    expect(session).toContain("tx ? await tx.execute(inventoryQuery)");
    expect(platform).toContain("requirePlatformReadAuthorityInTransaction(tx, claims)");
    expect(platform).toContain('listOwnSessions({ scope: "platform", claims }, cursors[0], tx)');
    expect(workspace).toContain('requireManagerActorInTransaction(tx, claims, "tenant.read")');
    expect(workspace).toContain('listOwnSessions({ scope: "workspace", claims }, cursors[0], tx)');
  });
});

const suite = describe.skipIf(!hasTestDatabase);
suite("Session directories reject owner and workspace lifecycle revocation races", () => {
  const ownerId = "platform-session-directory-owner";
  const email = "platform-session-directory-owner@example.test";
  let platformToken: string;
  let workspaceToken: string;
  let tenantId: string;
  let previousSecret: string | undefined;
  beforeAll(async () => {
    previousSecret = process.env.GATEWAY_JWT_SECRET;
    process.env.GATEWAY_JWT_SECRET = "session-directory-transaction-test-secret-32";
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    tenantId = (await seedFixture()).tenantId;
    await db.insert(users).values({
      id: ownerId, email, passwordHash: "verified-test-password-hash",
      emailVerifiedAt: new Date(), isPlatformOwner: true,
    });
    platformToken = (await createVerifiedPlatformSession(ownerId,email)).token;
    workspaceToken = (await createWorkspaceManagerTestSession(tenantId,{role:"owner"})).token;
  });
  afterAll(async () => {
    if (previousSecret !== undefined) process.env.GATEWAY_JWT_SECRET = previousSecret;
    else delete process.env.GATEWAY_JWT_SECRET;
    await closePool();
  });
  const read = (kind: "platform" | "workspace") => kind === "platform"
    ? platformGET(new Request("http://localhost/api/platform/auth/sessions", {headers:{Authorization:"Bearer "+platformToken}}))
    : workspaceGET(new Request("http://localhost/api/auth/sessions", {headers:{Authorization:"Bearer "+workspaceToken}}));

  it.each(["platform", "workspace"] as const)("lists only the current account's live %s sessions", async kind => {
    const response = await read(kind);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toHaveProperty("sessions");
  });

  it.each(["platform", "workspace"] as const)(
    "rejects %s listing after its authority row is changed while the guarded read waits", async kind => {
      const blocker = await pool().connect();
      let committed = false;
      let pending: Promise<Response> | undefined;
      try {
        await blocker.query("BEGIN");
        if (kind === "platform") {
          await blocker.query("UPDATE users SET is_platform_owner=false WHERE id=$1", [ownerId]);
        } else {
          await blocker.query("UPDATE tenants SET lifecycle='suspended' WHERE id=$1", [tenantId]);
        }
        const pid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        pending = read(kind);
        void pending.catch(() => undefined);
        await expect.poll(async () => {
          const x = await pool().query(
            "SELECT count(*)::int AS n FROM pg_stat_activity " +
            "WHERE datname=current_database() AND wait_event_type='Lock' " +
            "AND query LIKE $2 AND query LIKE '%FOR SHARE%' " +
            "AND $1=ANY(pg_blocking_pids(pid))",
            [pid, kind === "platform" ? "%FROM users%" : "%FROM tenants%"],
          );
          return Number(x.rows[0]?.n ?? 0);
        },{timeout:8000,interval:100}).toBeGreaterThan(0);
        await blocker.query("COMMIT");
        committed = true;
        const response = await pending;
        expect(response.status).toBe(kind === "platform" ? 401 : 403);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(await response.json()).not.toHaveProperty("sessions");
      } finally {
        if(!committed) await blocker.query("ROLLBACK");
        blocker.release();
        await pending?.catch(() => undefined);
      }
    },
  );
});
