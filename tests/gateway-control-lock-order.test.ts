import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({ statements: [] as Array<{ sql: string; params: unknown[] }> }));
const actor = vi.hoisted(() => ({
  tenantId: "tenant_control_fence", userId: "owner_control_fence", role: "owner",
  sub: "manager", kind: "manager", ver: 2, familyId: "c".repeat(32),
  sid: "b".repeat(32), jti: "a".repeat(32), iat: 1, exp: 901,
}));
const dialect = new PgDialect();
vi.mock("../src/lib/manager-auth", () => ({ validateWorkspaceManager: async () => actor }));
vi.mock("../src/lib/odoo-auth", () => ({
  validateOdooKey: async () => ({ id: "key_control_fence", tenantId: actor.tenantId, hashedKey: "digest", readOnly: false }),
  generateOdooApiKey: () => ({ id: "unused-key", raw: "unused-secret", hashed: "unused-digest" }),
}));
vi.mock("../src/db", () => ({ db: {
  query: { agents: { findFirst: async () => ({ id: "agt_AAAAAAAA", tenantId: actor.tenantId, lifecycle: "active" }) } },
  transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
    execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const compiled = dialect.sqlToQuery(query);
      state.statements.push({ sql: compiled.sql, params: compiled.params });
      if (/FROM tenants/.test(compiled.sql)) return { rows: [{ lifecycle: "suspended" }] };
      throw new Error("resource/advisory must not be acquired before the tenant fence");
    },
  }),
} }));

import { POST as startDiscovery } from "../src/app/api/agents/[id]/discovery/route";
import { POST as cancelDiscovery } from "../src/app/api/agents/[id]/discovery/[discoveryId]/cancel/route";
import { POST as verifyDiscovery } from "../src/app/api/agents/[id]/discovered-printers/[deviceId]/verify/route";
import { POST as provisionDiscovery } from "../src/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route";
import { DELETE as removeKey } from "../src/app/api/odoo/keys/route";
import { POST as rotateKey } from "../src/app/api/odoo/keys/[id]/rotate/route";
import { PATCH as configureOdoo } from "../src/app/api/odoo/configuration/route";

function request(body: object, method = "POST") {
  return new Request("https://gateway.example.test/api/control", {
    method, headers: { "content-type": "application/json", "If-Match": `"${"a".repeat(64)}"` },
    body: JSON.stringify(body),
  });
}
const agentParams = () => ({ params: Promise.resolve({ id: "agt_AAAAAAAA", discoveryId: "dsc_test", deviceId: "candidate_test" }) });
const operations: Array<[string, () => Promise<Response>]> = [
  ["discovery start", () => startDiscovery(request({ timeoutMs: 30_000 }), agentParams())],
  ["discovery cancel", () => cancelDiscovery(request({}), agentParams())],
  ["discovery verify", () => verifyDiscovery(request({}), agentParams())],
  ["discovery provision", () => provisionDiscovery(request({}), agentParams())],
  ["key revoke", () => removeKey(request({ id: "key_test" }, "DELETE"))],
  ["key erase", () => removeKey(request({ id: "key_test", remove: true }, "DELETE"))],
  ["key rotate", () => rotateKey(request({}), { params: Promise.resolve({ id: "key_test" }) })],
  ["Odoo activation", () => configureOdoo(request({ enabled: false, revision: 1 }, "PATCH"))],
];

describe("runtime control follows tenant-row before advisory/resource/actor locks", () => {
  it.each(operations)("%s denies changed lifecycle before acquiring another lock or mutating", async (_name, operation) => {
    state.statements.length = 0;
    const response = await operation();
    expect(response.status).toBe(403);
    expect(state.statements).toHaveLength(1);
    expect(state.statements[0].sql).toContain("FROM tenants");
    expect(state.statements[0].sql).toContain("FOR SHARE");
    expect(state.statements[0].params).toEqual([actor.tenantId]);
  });
});
