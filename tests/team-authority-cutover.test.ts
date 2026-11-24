import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({ loggedIn: false }));
vi.mock("../src/lib/manager-auth", () => ({
  validateWorkspaceManager: async () => session.loggedIn
    ? ({ userId: "workspace-user", tenantId: "workspace", role: "admin" })
    : null,
}));
import { PATCH, DELETE } from "../src/app/api/team/members/route";

describe("workspace member mutation authority", () => {
  beforeEach(() => { session.loggedIn = false; vi.stubEnv("APP_BASE_URL", "https://gateway.test"); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it("returns 401 for an unauthenticated role-change attempt, not a fabricated permission denial", async () => {
    const response = await PATCH(new Request("http://gateway.test/api/team/members", {
      method: "PATCH", body: JSON.stringify({ userId: "any", role: "owner" }),
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("returns 403 for a signed-in Full Access member trying to remove a colleague", async () => {
    session.loggedIn = true;
    const response = await DELETE(new Request("https://gateway.test/api/team/members?userId=any", {
      method: "DELETE", headers: { origin: "https://gateway.test" },
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "OWNER_REQUIRED" });
  });
});
