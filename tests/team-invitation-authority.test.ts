import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GET, POST, DELETE } from "../src/app/api/platform/tenants/[id]/invitations/route";

describe("Platform Admin has no invitation mutation surface", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
    ["DELETE", DELETE],
  ] as const)("retired %s endpoint never reads or mutates a workspace", async (_verb, action) => {
    const response = await action();
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "INVITATIONS_MOVED" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("the workspace Team page retains a scoped, guarded Full Access invitation flow", () => {
    const team = readFileSync("src/app/api/team/invitations/route.ts", "utf8");
    const platform = readFileSync("src/app/api/platform/tenants/[id]/invitations/route.ts", "utf8");
    expect(team).toContain("requireWorkspaceOwnerForInvites(tx, claims)");
    expect(team).toContain('role: "admin"');
    expect(team).toContain("INVITATION_DELIVERY_UNAVAILABLE");
    expect(platform).not.toContain("sendTransactionalEmail");
    expect(platform).not.toContain("tenantInvitations");
  });
});
