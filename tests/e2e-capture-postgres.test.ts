import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { hasTestDatabase, applyMigrations, seedFixture, closePool, pool, type Fixture } from "./helpers/pg";
import { POST as start, GET as read } from "../src/app/api/odoo/test-captures/route";
import { GET as claim, PATCH as finish } from "../src/app/api/agent/test-captures/route";
import { GET as inbox, DELETE as purge } from "../src/app/api/agent/test-captures/status/route";
import { GET as preview } from "../src/app/api/agent/test-captures/preview/route";

const root = "http://localhost:3000";
const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const key = () => "e2e-" + randomBytes(16).toString("hex");
function odoo(f: Fixture, method: "GET" | "POST", body?: unknown, id?: string) {
  return new Request(root + "/api/odoo/test-captures" + (id ? "?id=" + id : ""), {
    method, headers: { Authorization: "Bearer " + f.odooKey, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function agent(f: Fixture, method: "GET" | "PATCH", body?: unknown) {
  return new Request(root + "/api/agent/test-captures", {
    method, headers: { Authorization: f.agentAuth, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function request(f: Fixture, idempotencyKey = key(), data = pdf) {
  return {
    agentId: f.agentId, idempotencyKey, paperMm: 0,
    payload: { type: "pdf", encoding: "base64", data: data.toString("base64") },
  };
}
const run = describe.skipIf(!hasTestDatabase);
run("E2E PDFium capture queue PostgreSQL tenant and claim fences", () => {
  let owner: Fixture;
  let outsider: Fixture;
  const original = process.env.YASEIR_E2E_CAPTURE_ENABLED;
  beforeAll(async () => {
    process.env.YASEIR_E2E_CAPTURE_ENABLED = "1";
    await applyMigrations();
    owner = await seedFixture();
    outsider = await seedFixture();
  });
  afterAll(async () => {
    if (original === undefined) delete process.env.YASEIR_E2E_CAPTURE_ENABLED;
    else process.env.YASEIR_E2E_CAPTURE_ENABLED = original;
    await closePool();
  });

  it("runs Odoo -> Gateway -> Agent -> Gateway -> Odoo with no physical print", async () => {
    const body = request(owner);
    const submitted = await start(odoo(owner, "POST", body));
    expect(submitted.status).toBe(202);
    const accepted = await submitted.json();
    expect(accepted.runId).toMatch(/^cap_[0-9a-f]{32}$/);
    expect(accepted.physicalPrinted).toBe(false);
    expect((await start(odoo(owner, "POST", body))).status).toBe(200);
    const alternate = request(owner, body.idempotencyKey,
      Buffer.from("%PDF-1.4\n2 0 obj\n<<>>\nendobj\n%%EOF\n"));
    const conflict = await start(odoo(owner, "POST", alternate));
    expect(conflict.status).toBe(409);
    expect((await claim(agent(outsider, "GET"))).status).toBe(204);
    expect((await read(odoo(outsider, "GET", undefined, accepted.runId))).status).toBe(404);
    const ownerInbox = await inbox(agent(owner, "GET"));
    expect(ownerInbox.status).toBe(200);
    expect((await ownerInbox.json()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: accepted.runId, status: "queued" }),
    ]));
    const strangerInbox = await inbox(agent(outsider, "GET"));
    expect((await strangerInbox.json()).items.some((x: { runId: string }) => x.runId === accepted.runId)).toBe(false);
    expect((await preview(new Request(root + "/api/agent/test-captures/preview?id=" + accepted.runId,
      { headers: { Authorization: outsider.agentAuth } }))).status).toBe(404);
    const fetched = await claim(agent(owner, "GET"));
    expect(fetched.status).toBe(200);
    const envelope = await fetched.json();
    expect(envelope).toMatchObject({
      runId: accepted.runId, simulationOnly: true, physicalPrinterId: null,
    });
    expect(envelope.payload.data).toBe(body.payload.data);
    const claimedInbox = await inbox(agent(owner, "GET"));
    expect((await claimedInbox.json()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: accepted.runId, status: "claimed" }),
    ]));
    expect((await claim(agent(owner, "GET"))).status).toBe(204);
    expect((await finish(agent(owner, "PATCH", {
      runId: accepted.runId, claimToken: "0".repeat(64), status: "rendered_locally",
      pages: 1, pdfSha256: "a".repeat(64), pdfBytes: 240,
    }))).status).toBe(409);
    const reported = await finish(agent(owner, "PATCH", {
      runId: accepted.runId, claimToken: envelope.claimToken, status: "rendered_locally",
      pages: 1, pdfSha256: "a".repeat(64), pdfBytes: 240,
      previewJpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
    }));
    expect(reported.status).toBe(200);
    expect((await reported.json()).physicalPrinted).toBe(false);
    expect((await finish(agent(owner, "PATCH", {
      runId: accepted.runId, claimToken: envelope.claimToken,
      status: "failed", errorCode: "PDFIUM_FAILED",
    }))).status).toBe(409);
    const thumb = await preview(new Request(root + "/api/agent/test-captures/preview?id=" + accepted.runId,
      { headers: { Authorization: owner.agentAuth } }));
    expect(thumb.status).toBe(200);
    expect((await thumb.json()).previewDataUri).toMatch(/^data:image\/jpeg;base64,/);
    const completedInbox = await inbox(agent(owner, "GET"));
    expect((await completedInbox.json()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: accepted.runId, status: "rendered_locally", pages: 1 }),
    ]));
    const visible = await read(odoo(owner, "GET", undefined, accepted.runId));
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({
      status: "rendered_locally", outcome: "simulation_only",
      pageCount: 1, physicalPrinted: false,
    });
    const rows = await pool().query("SELECT status,payload_json,claim_token_hash FROM e2e_capture_runs WHERE id=$1", [accepted.runId]);
    expect(rows.rows[0]).toMatchObject({
      status: "rendered_locally", payload_json: null, claim_token_hash: null,
    });
    const count = await pool().query("SELECT count(*)::integer AS n FROM print_jobs WHERE tenant_id=$1", [owner.tenantId]);
    expect(Number(count.rows[0].n)).toBe(0);
  }, 30_000);

  it("purges only this Agent's completed/expired captures, never active work or print jobs", async () => {
    const completed = await start(odoo(owner, "POST", request(owner)));
    expect(completed.status).toBe(202);
    const doneId = (await completed.json()).runId as string;
    const claimed = await claim(agent(owner, "GET"));
    expect(claimed.status).toBe(200);
    const token = (await claimed.json()).claimToken as string;
    expect((await finish(agent(owner, "PATCH", {
      runId: doneId, claimToken: token, status: "rendered_locally",
      pages: 1, pdfSha256: "a".repeat(64), pdfBytes: 256,
      previewJpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
    }))).status).toBe(200);

    const waiting = await start(odoo(owner, "POST", request(owner)));
    expect(waiting.status).toBe(202);
    const waitingId = (await waiting.json()).runId as string;
    const unauthenticated = await purge(new Request(root + "/api/agent/test-captures/status", { method: "DELETE" }));
    expect(unauthenticated.status).toBe(401);
    const otherAgent = await purge(new Request(root + "/api/agent/test-captures/status", {
      method: "DELETE", headers: { Authorization: outsider.agentAuth },
    }));
    expect(otherAgent.status).toBe(200);
    expect((await otherAgent.json()).deleted).toBe(0);
    expect((await read(odoo(owner, "GET", undefined, doneId))).status).toBe(200);

    const cleared = await purge(new Request(root + "/api/agent/test-captures/status", {
      method: "DELETE", headers: { Authorization: owner.agentAuth },
    }));
    expect(cleared.status).toBe(200);
    const report = await cleared.json();
    expect(report).toMatchObject({ activePreserved: true, physicalJobsAffected: false });
    expect(report.deleted).toBeGreaterThanOrEqual(1);
    expect((await read(odoo(owner, "GET", undefined, doneId))).status).toBe(404);
    expect((await preview(new Request(root + "/api/agent/test-captures/preview?id=" + doneId,
      { headers: { Authorization: owner.agentAuth } }))).status).toBe(404);
    expect((await read(odoo(owner, "GET", undefined, waitingId))).status).toBe(200);

    const zero = await purge(new Request(root + "/api/agent/test-captures/status", {
      method: "DELETE", headers: { Authorization: owner.agentAuth },
    }));
    expect((await zero.json()).deleted).toBe(0);
    expect((await pool().query("SELECT status FROM e2e_capture_runs WHERE id=$1", [waitingId])).rows[0].status).toBe("queued");
    const printed = await pool().query("SELECT count(*)::integer AS n FROM print_jobs WHERE tenant_id=$1", [owner.tenantId]);
    expect(Number(printed.rows[0].n)).toBe(0);
    await pool().query("DELETE FROM e2e_capture_runs WHERE id=$1", [waitingId]);
  }, 30_000);

  it("rechecks suspension under the tenant lock before handing off or completing a capture", async () => {
    const fixture = await seedFixture();
    const submitted = await start(odoo(fixture, "POST", request(fixture)));
    expect(submitted.status).toBe(202);
    const id = (await submitted.json()).runId;
    const holder = await pool().connect();
    try {
      for (const mode of ["claim", "finish"] as const) {
        await pool().query("UPDATE tenants SET lifecycle='active' WHERE id=$1", [fixture.tenantId]);
        const claimed = mode === "finish" ? await claim(agent(fixture, "GET")) : null;
        if (claimed) expect(claimed.status).toBe(200);
        const envelope = claimed ? await claimed.json() : null;
        await holder.query("BEGIN");
        const pid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await holder.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [fixture.tenantId]);
        const pending = mode === "claim" ? claim(agent(fixture, "GET")) : finish(agent(fixture, "PATCH", {
          runId: id, claimToken: envelope.claimToken, status: "rendered_locally",
          pages: 1, pdfSha256: "a".repeat(64), pdfBytes: 240,
        }));
        await vi.waitFor(async () => {
          const blocked = await pool().query("SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))", [pid]);
          expect(blocked.rows.length).toBeGreaterThan(0);
        }, { timeout: 5000, interval: 20 });
        await holder.query("UPDATE tenants SET lifecycle='suspended' WHERE id=$1", [fixture.tenantId]);
        await holder.query("COMMIT");
        expect((await pending).status).toBe(mode === "claim" ? 204 : 409);
        expect((await pool().query("SELECT status FROM e2e_capture_runs WHERE id=$1", [id])).rows[0].status)
          .toBe(mode === "claim" ? "queued" : "claimed");
      }
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 30_000);

  it("fails closed for another tenant and after installation-key revocation", async () => {
    expect((await start(odoo(owner, "POST", {
      ...request(owner), agentId: outsider.agentId,
    }))).status).toBe(404);
    const submitted = await start(odoo(owner, "POST", request(owner)));
    expect(submitted.status).toBe(202);
    const id = (await submitted.json()).runId;
    await pool().query("UPDATE api_keys SET revoked_at=now() WHERE tenant_id=$1", [owner.tenantId]);
    expect((await start(odoo(owner, "POST", request(owner)))).status).toBe(401);
    expect((await claim(agent(owner, "GET"))).status).toBe(204);
    expect((await pool().query("SELECT status FROM e2e_capture_runs WHERE id=$1", [id])).rows[0].status).toBe("queued");
  }, 30_000);

  it("key deletion cannot deadlock capture expiry and must prevent document handoff", async () => {
    const fixture = await seedFixture();
    const first = await start(odoo(fixture, "POST", request(fixture)));
    const second = await start(odoo(fixture, "POST", request(fixture)));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const expiredId = (await first.json()).runId;
    await pool().query("UPDATE e2e_capture_runs SET expires_at=now()-interval '1 second' WHERE id=$1", [expiredId]);
    const holder = await pool().connect();
    try {
      await holder.query("BEGIN");
      const pid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await holder.query("SELECT id FROM api_keys WHERE tenant_id=$1 FOR UPDATE", [fixture.tenantId]);
      const pending = claim(agent(fixture, "GET"));
      await vi.waitFor(async () => {
        const blocked = await pool().query("SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))", [pid]);
        expect(blocked.rows.length).toBeGreaterThan(0);
      }, { timeout: 5000, interval: 20 });
      await holder.query("DELETE FROM api_keys WHERE tenant_id=$1", [fixture.tenantId]);
      await holder.query("COMMIT");
      expect((await pending).status).toBe(204);
      expect((await pool().query("SELECT id FROM e2e_capture_runs WHERE tenant_id=$1", [fixture.tenantId])).rows).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 30_000);
});
