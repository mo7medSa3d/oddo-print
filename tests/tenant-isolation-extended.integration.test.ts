import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { tenants, users, tenantUsers, managerSessions, printJobs } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { validateWorkspaceManager } from "../src/lib/manager-auth";
import { GET as timelineGET } from "../src/app/api/jobs/[id]/timeline/route";
import { GET as teamMembersGET } from "../src/app/api/team/members/route";
import { GET as billingStatusGET } from "../src/app/api/billing/status/route";
import { hasTestDatabase, applyMigrations, truncateAll, closePool, seedFixture, insertQueuedJob, pool } from "./helpers/pg";

vi.mock(import("../src/lib/manager-auth"), async (importOriginal) => ({
  ...(await importOriginal()),
  validateManager: vi.fn(),
  validateWorkspaceManager: vi.fn(),
}));
vi.mock("../src/lib/authorization", () => ({
  requireManagerPermission: vi.fn(),
  hasManagerPermission: vi.fn(() => true),
}));

const suite = describe.skipIf(!hasTestDatabase);

let currentTenant = "";
vi.mocked(validateWorkspaceManager).mockImplementation(async () => ({
  jti: "test-manager-jti-xiso", iat: Math.floor(Date.now() / 1000) - 10,
  exp: Math.floor(Date.now() / 1000) + 3600, sub: "manager",
  tenantId: currentTenant, userId: "user_xiso", role: "owner",
}) as never);

function authed(url: string, init?: RequestInit): Request {
  return new Request(url, { ...init, headers: { ...(init?.headers ?? {}), cookie: "mgr_session=x" } });
}

suite("Tenant isolation extended vectors (J-6)", () => {
  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => {
    await truncateAll();
    vi.stubEnv("APP_BASE_URL", "https://xiso.test");
  });
  afterAll(async () => { await closePool(); });

  async function twoTenants() {
    const a = await seedFixture();
    const b = await seedFixture();
    await db.insert(users).values({ id: "user_xiso", email: "xiso@example.test", passwordHash: "unused" });
    for (const f of [a, b]) {
      await db.insert(tenantUsers).values({ userId: "user_xiso", tenantId: f.tenantId, role: "owner" });
    }
    return { a, b };
  }

  it("Odoo key B cannot read or batch-read tenant A jobs", async () => {
    const { a, b } = await twoTenants();
    await insertQueuedJob(a, "job_xiso_a");
    const { GET: jobGET } = await import("../src/app/api/print/jobs/route");
    const single = await jobGET(new Request(`http://gateway.test/api/print/jobs?id=job_xiso_a`, {
      headers: { Authorization: `Bearer ${b.odooKey}` },
    }));
    expect(single.status).toBe(404);
    const { POST: batchPOST } = await import("../src/app/api/print/jobs/batch-status/route");
    const batch = await batchPOST(new Request("http://gateway.test/api/print/jobs/batch-status", {
      method: "POST",
      headers: { Authorization: `Bearer ${b.odooKey}`, "Content-Type": "application/json", "Content-Length": "100" },
      body: JSON.stringify({ jobIds: ["job_xiso_a"] }),
    }));
    expect(batch.status).toBe(200);
    expect(((await batch.json()) as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it("manager of B cannot read A's job timeline", async () => {
    const { a, b } = await twoTenants();
    await insertQueuedJob(a, "job_xiso_timeline");
    currentTenant = b.tenantId;
    const res = await timelineGET(authed("http://gateway.test/api/jobs/job_xiso_timeline/timeline"), { params: Promise.resolve({ id: "job_xiso_timeline" }) });
    expect([401, 403, 404]).toContain(res.status);
    const row = await pool().query("SELECT tenant_id FROM print_jobs WHERE id = $1", ["job_xiso_timeline"]);
    expect(row.rows[0].tenant_id).toBe(a.tenantId);
  });

  it("manager of B sees only B members and B billing status", async () => {
    const { a, b } = await twoTenants();
    currentTenant = b.tenantId;
    const members = await teamMembersGET(authed("http://gateway.test/api/team/members"));
    expect(members.status).toBe(200);
    const memberBody = (await members.json()) as { members?: Array<{ tenantId?: string }> } & Record<string, unknown>;
    const list = Array.isArray(memberBody.members) ? memberBody.members : [];
    expect(list.length).toBeGreaterThan(0);
    for (const m of list) {
      if (m.tenantId !== undefined) expect(m.tenantId).toBe(b.tenantId);
    }
    expect(JSON.stringify(memberBody)).not.toContain(a.tenantId);
    const billing = await billingStatusGET(authed("http://gateway.test/api/billing/status"));
    expect(billing.status).toBe(200);
    expect(JSON.stringify(await billing.json())).not.toContain(a.tenantId);
  });

});
