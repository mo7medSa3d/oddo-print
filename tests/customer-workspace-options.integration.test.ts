import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/auth/login/route";
import { authenticateForTenant } from "../src/lib/customer-auth";
import { hashPassword } from "../src/lib/password";
import { applyMigrations, closePool, hasTestDatabase, pool, truncateAll } from "./helpers/pg";

describe.skipIf(!hasTestDatabase)("workspace choices follow live memberships", () => {
  let userId: string;
  let email: string;
  const password = "Synthetic-workspace-password-123";
  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "workspace-options-synthetic-secret-at-least-32-characters");
    await applyMigrations();
  });
  afterAll(async () => { vi.unstubAllEnvs(); await closePool(); });
  beforeEach(async () => {
    await truncateAll();
    userId = `user_${randomUUID()}`;
    email = `${randomUUID()}@example.test`;
    await pool().query("INSERT INTO users(id,email,password_hash,email_verified_at) VALUES ($1,$2,$3,now())", [userId,email,await hashPassword(password)]);
    for (const [id,name,lifecycle,member] of [
      ["cairo","Cairo store","active",true], ["giza","متجر الجيزة","active",true],
      ["suspended","Unavailable store","suspended",true], ["unrelated","Private other workspace","active",false],
    ] as const) {
      await pool().query("INSERT INTO tenants(id,name,lifecycle) VALUES ($1,$2,$3)", [id,name,lifecycle]);
      if (member) await pool().query("INSERT INTO tenant_users(tenant_id,user_id,role) VALUES ($1,$2,'owner')", [id,userId]);
    }
  });

  it("returns only named active workspaces after password verification", async () => {
    const response = await POST(new Request("https://gateway.test/api/auth/login", {
      method: "POST", body: JSON.stringify({ email,password }),
    }));
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result.workspaceOptions).toEqual([{ id: "cairo",name: "Cairo store" },{ id: "giza",name: "متجر الجيزة" }]);
    expect(result.workspaces).toEqual(["cairo","giza"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not offer an unavailable workspace or disclose memberships to a wrong password", async () => {
    expect(await authenticateForTenant(email,"incorrect-password")).toBeNull();
    expect(await authenticateForTenant(email,password,"suspended")).toBeNull();
    expect(await authenticateForTenant(email,password,"unrelated")).toBeNull();
    await pool().query("UPDATE tenants SET lifecycle='suspended' WHERE id='giza'");
    const identity = await authenticateForTenant(email,password);
    expect(identity).toMatchObject({ userId,tenantId: "cairo",role: "owner" });
    expect(identity).not.toHaveProperty("selectionToken");
  });

  it("rejects malformed explicit selectors instead of logging into the sole remaining workspace", async () => {
    await pool().query("UPDATE tenants SET lifecycle='suspended' WHERE id='giza'");
    for (const tenantId of [null, "", 42, false, [], {}, "x".repeat(129)]) {
      const response = await POST(new Request("https://gateway.test/api/auth/login", {
        method: "POST", body: JSON.stringify({ email, password, tenantId }),
      }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect((await pool().query("SELECT count(*)::int AS count FROM refresh_tokens WHERE user_id=$1", [userId])).rows[0].count).toBe(0);
    const selected = await POST(new Request("https://gateway.test/api/auth/login", {
      method: "POST", body: JSON.stringify({ email, password, tenantId: "cairo" }),
    }));
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ tenantId: "cairo" });
  });
});
