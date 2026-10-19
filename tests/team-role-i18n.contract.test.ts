import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROLE_KEYS = [
  "team.role.owner",
  "team.role.admin",
  "team.role.operator",
  "team.role.viewer",
  "team.role.integrationAdmin",
  "team.role.billingAdmin",
] as const;

describe("team role labels follow the active language", () => {
  it("maps every role through the shared translator helper", () => {
    const helper = readFileSync("src/lib/roles.ts", "utf8");
    const en = readFileSync("src/i18n/messages/en.ts", "utf8");
    const ar = readFileSync("src/i18n/messages/ar.ts", "utf8");

    for (const key of ROLE_KEYS) {
      expect(helper).toContain(`t("${key}")`);
      expect(en).toContain(`"${key}":`);
      expect(ar).toContain(`"${key}":`);
    }
    // Unknown future roles keep a readable English fallback, but only in the
    // default branch — every known role goes through the translator.
    expect(helper).toMatch(/default:\s*\n\s*return role\.replace/);
  });

  it("team table and settings both use the shared helper with the translator", () => {
    const page = readFileSync("src/app/team/page.tsx", "utf8");
    const settings = readFileSync("src/app/settings/page.tsx", "utf8");
    expect(page).toContain('from "../../lib/roles"');
    expect(page).toContain("roleLabel(value, t)");
    expect(page).toContain("roleLabel(member.role, t)");
    expect(page).toContain("roleLabel(invitation.role, t)");
    expect(page).not.toMatch(/function roleLabel\(/);
    // Settings must not render integration_admin/billing_admin as Unknown.
    expect(settings).toContain("roleLabel(role, t)");
    expect(settings).not.toContain('t("common.unknown")');
  });
});
