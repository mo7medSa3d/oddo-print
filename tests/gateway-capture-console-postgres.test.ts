import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasTestDatabase, applyMigrations, seedFixture, closePool, pool } from "./helpers/pg";
import { gatewayTestSigningKey } from "./helpers/test-secrets";
import { randomBytes } from "node:crypto";
import { createManagerSession } from "../src/lib/manager-auth";
import { GET as list, DELETE as purge } from "../src/app/api/test-captures/route";
import { GET as preview } from "../src/app/api/test-captures/preview/route";

describe.skipIf(!hasTestDatabase)("Gateway E2E capture visibility and safe deletion", () => {
  let tenant = "";
  let otherTenant = "";
  let adminCookie = "";
  let viewerCookie = "";
  let outsiderCookie = "";
  const previous = process.env.GATEWAY_JWT_SECRET;

  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey();
    await applyMigrations();
    tenant = (await seedFixture()).tenantId;
    otherTenant = (await seedFixture()).tenantId;
    adminCookie = "mgr_session=" + (await createManagerSession(tenant)).token;
    viewerCookie = "mgr_session=" + (await createManagerSession(tenant, { role: "viewer" })).token;
    outsiderCookie = "mgr_session=" + (await createManagerSession(otherTenant)).token;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.GATEWAY_JWT_SECRET;
    else process.env.GATEWAY_JWT_SECRET = previous;
    await closePool();
  });

  function request(path: string, cookie = adminCookie, method = "GET", body?: unknown) {
    return new Request("http://localhost:3000" + path, {
      method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  it("separates tenant status metadata, previews and read-only members", async () => {
    const ownId = "cap_" + randomBytes(16).toString("hex");
    const foreignId = "cap_" + randomBytes(16).toString("hex");
    const pendingId = "cap_" + randomBytes(16).toString("hex");
    const image = Buffer.from([255, 216, 255, 217]).toString("base64");
    const insert = `INSERT INTO e2e_capture_runs
      (id, tenant_id, agent_id, api_key_id, idempotency_key, fingerprint, paper_mm, status, pages, pdf_bytes, preview_jpeg)
      SELECT $1, tenant_id, id, (SELECT id FROM api_keys WHERE tenant_id=agents.tenant_id LIMIT 1), $2, $3, 80,
        'rendered_locally', 1, 128, $4 FROM agents WHERE tenant_id=$5 LIMIT 1`;
    await pool().query(insert, [ownId, ownId, "f".repeat(64), image, tenant]);
    await pool().query(insert, [foreignId, foreignId, "f".repeat(64), image, otherTenant]);
    await pool().query(insert, [pendingId, pendingId, "f".repeat(64), image, tenant]);
    await pool().query("UPDATE e2e_capture_runs SET status='queued', pages=NULL, preview_jpeg=NULL, payload_json=$2::jsonb, expires_at=now() + interval '10 minutes' WHERE id=$1", [pendingId, JSON.stringify({ type: "pdf", encoding: "base64", data: "AA==" })]);

    const own = await list(request("/api/test-captures"));
    expect(own.status).toBe(200);
    const body = await own.json();
    expect(body.summary.gatewayReceived).toBeGreaterThanOrEqual(1);
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: ownId, status: "rendered_locally", gatewayReceived: true }),
    ]));
    expect(JSON.stringify(body)).not.toContain("previewJpeg");
    expect(JSON.stringify(body)).not.toContain("payloadJson");
    expect(body.items.some((x: { runId: string }) => x.runId === foreignId)).toBe(false);
    await pool().query("UPDATE e2e_capture_runs SET status='claimed', claimed_at=now() WHERE id=$1", [pendingId]);
    const claimedTimeline = await (await list(request("/api/test-captures"))).json();
    expect(claimedTimeline.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: pendingId, status: "claimed", gatewayReceived: true, agentReceived: true }),
    ]));
    expect(claimedTimeline.summary.agentReceived).toBeGreaterThanOrEqual(1);
    expect((await list(request("/api/test-captures", outsiderCookie))).status).toBe(200);
    expect((await list(request("/api/test-captures", viewerCookie))).status).toBe(200);
    expect((await preview(request("/api/test-captures/preview?id=" + foreignId))).status).toBe(404);
    expect((await preview(request("/api/test-captures/preview?id=" + ownId, viewerCookie))).status).toBe(403);
    expect((await preview(request("/api/test-captures/preview?id=" + ownId))).status).toBe(200);

    expect((await purge(request("/api/test-captures", viewerCookie, "DELETE", { scope: "one", runId: ownId, confirm: true }))).status).toBe(403);
    expect((await purge(request("/api/test-captures", adminCookie, "DELETE", { scope: "one", runId: foreignId, confirm: true }))).status).toBe(404);
    expect((await purge(request("/api/test-captures", adminCookie, "DELETE", { scope: "one", runId: ownId, confirm: false }))).status).toBe(400);
    expect((await purge(request("/api/test-captures", adminCookie, "DELETE", { scope: "one", runId: pendingId, confirm: true }))).status).toBe(409);
    const gone = await purge(request("/api/test-captures", adminCookie, "DELETE", { scope: "one", runId: ownId, confirm: true }));
    expect(gone.status).toBe(200);
    expect((await gone.json()).physicalJobsAffected).toBe(false);
    expect((await preview(request("/api/test-captures/preview?id=" + ownId))).status).toBe(404);
    expect((await pool().query("SELECT count(*)::integer AS total FROM e2e_capture_runs WHERE id=$1", [pendingId])).rows[0].total).toBe(1);
    expect((await pool().query("SELECT count(*)::integer AS total FROM print_jobs WHERE tenant_id=$1", [tenant])).rows[0].total).toBe(0);
    await pool().query("DELETE FROM e2e_capture_runs WHERE id = ANY($1::text[])", [[foreignId, pendingId]]);
  }, 30_000);
});
