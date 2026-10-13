import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { hasTestDatabase, applyMigrations, seedFixture, closePool, pool, type Fixture } from "./helpers/pg";
import { POST as start, GET as read } from "../src/app/api/odoo/test-captures/route";
import { GET as claim, PATCH as finish } from "../src/app/api/agent/test-captures/route";
import { GET as inbox } from "../src/app/api/agent/test-captures/status/route";
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
    expect((await thumb.json()).previewDataUri).toMatch(/^data:image\\/jpeg;base64,/);
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
});
