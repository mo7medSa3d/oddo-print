import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("workspace owner member removal", () => {
  it("allows removal only for accepted invites sent by the current owner", () => {
    const route = read("src/app/api/team/members/route.ts");
    const page = read("src/app/team/page.tsx");
    expect(route).toContain("requireWorkspaceOwnerForInvites(tx, claims)");
    expect(route).toContain("i.inviter_user_id=${claims.userId}");
    expect(route).toContain("i.accepted_at IS NOT NULL");
    expect(route).toContain('member.role === "owner"');
    expect(route).toContain("revokeUserTenantRefreshFamiliesInTransaction");
    expect(route).toContain('action: "team.member.removed"');
    expect(page).toContain("removableByCurrentOwner");
    expect(page).toContain('method: "DELETE"');
  });
});
