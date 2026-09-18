import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  applyMigrations,
  closePool,
  hasTestDatabase,
  pool,
  seedFixture,
  truncateAll,
} from "./helpers/pg";
import { createManagerSession } from "../src/lib/manager-auth";
import { POST as printersPOST } from "../src/app/api/printers/route";
import { PATCH as printerPATCH } from "../src/app/api/printers/[id]/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("printer desired-state authority", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it("persists manager-owned desired state and increments its revision atomically", async () => {
    const f = await seedFixture();
    const session = await createManagerSession(f.tenantId);

    const createdResponse = await printersPOST(new Request("http://gateway.test/api/printers", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + session.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Gateway Receipt",
        agentId: f.agentId,
        printerType: "physical",
        deviceClass: "thermal",
        connectionType: "network",
        protocol: "raw",
        config: { ip: "192.168.1.50", port: 9100 },
      }),
    }));

    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.managementSource).toBe("manager");
    expect(created.desiredRevision).toBe(1);
    expect(created.appliedDesiredRevision).toBe(0);
    expect(created.observedDesiredRevision).toBe(0);

    const patchResponse = await printerPATCH(new Request(
      "http://gateway.test/api/printers/" + encodeURIComponent(created.id),
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer " + session.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Gateway Receipt v2",
          config: { ip: "192.168.1.51", port: 9100 },
        }),
      },
      ),
      { params: Promise.resolve({ id: created.id }) },
    );

    expect(patchResponse.status).toBe(200);
    const patched = await patchResponse.json();
    expect(patched.name).toBe("Gateway Receipt v2");
    expect(patched.desiredRevision).toBe(2);
    expect(patched.appliedDesiredRevision).toBe(0);
    expect(patched.observedDesiredRevision).toBe(0);

    const row = await pool().query(
      `SELECT management_source, desired_revision, applied_desired_revision, observed_desired_revision
       FROM printers WHERE id = $1`,
      [created.id],
    );
    expect(row.rows[0]).toEqual({
      management_source: "manager",
      desired_revision: "2",
      applied_desired_revision: "0",
      observed_desired_revision: "0",
    });

    const audits = await pool().query(
      `SELECT action, resource_id FROM audit_events
       WHERE resource_id = $1 ORDER BY created_at ASC`,
      [created.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual(["printer.registered", "printer.changed"]);
  });

  it("never exposes one tenant's desired printer through another manager token", async () => {
    const first = await seedFixture();
    const second = await seedFixture();
    const session = await createManagerSession(second.tenantId);

    const response = await printerPATCH(
      new Request("http://gateway.test/api/printers/" + encodeURIComponent(first.printerId), {
        method: "PATCH",
        headers: {
          Authorization: "Bearer " + session.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "cross-tenant" }),
      }),
      { params: Promise.resolve({ id: first.printerId }) },
    );

    expect(response.status).toBe(404);
    const row = await pool().query(
      "SELECT name, desired_revision FROM printers WHERE id = $1",
      [first.printerId],
    );
    expect(row.rows[0].name).not.toBe("cross-tenant");
    expect(row.rows[0].desired_revision).toBe("0");
  });
});
