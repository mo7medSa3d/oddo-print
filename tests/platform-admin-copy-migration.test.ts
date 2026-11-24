import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { translate } from "../src/i18n/translate";
import type { MessageKey } from "../src/i18n/messages/en";

/**
 * Platform Admin two-copy-system unification (WP-C).
 *
 * The old `a()` indirection (`useAdminText`) resolved `v4.admin.<key>` through
 * the same catalogue as `t()`, but hid the full key from readers and from
 * key-coverage tooling. Migrated pages call `t("v4.admin.<key>")` directly.
 * Every literal key a migrated page renders must resolve to real copy in
 * both locales — never the "Text unavailable" fallback and never the key
 * itself — and no migrated page may still import the old helper.
 */
const PAGES = [
  "src/app/platform/dashboard/page.tsx",
  "src/app/platform/plans/page.tsx",
  "src/app/platform/subscription-requests/page.tsx",
  "src/app/platform/subscriptions/page.tsx",
  "src/app/platform/tenants/[id]/page.tsx",
] as const;

const COMPONENTS = [
  "src/components/platform/SubscriptionEditor.tsx",
  "src/components/platform/WorkspaceLifecycle.tsx",
] as const;

function literalAdminKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/t\("v4\.admin\.([^"]+)"\)/g)) keys.add(match[1]);
  return [...keys];
}

function resolvesInBothLocales(key: string) {
  for (const locale of ["en", "ar"] as const) {
    const text = translate(locale, `v4.admin.${key}` as MessageKey);
    expect(text, `${key} in ${locale}`).not.toBe("Text unavailable");
    expect(text, `${key} in ${locale}`).not.toBe("النص غير متاح");
    expect(text, `${key} in ${locale}`).not.toBe(`v4.admin.${key}`);
    expect(text.trim().length, `${key} in ${locale}`).toBeGreaterThan(0);
  }
}

describe("platform copy migration (a() -> t())", () => {
  it.each([...PAGES, ...COMPONENTS])("resolves every literal admin key in %s in both locales", (file) => {
    const source = fs.readFileSync(file, "utf8");
    expect(source).not.toContain("useAdminText");
    const keys = literalAdminKeys(source);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) resolvesInBothLocales(key);
  });

  it("keeps no a() copy call in any migrated page or component", () => {
    for (const file of [...PAGES, ...COMPONENTS]) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/\ba\(/);
    }
  });

  it("resolves the dynamic-domain keys used through t(`v4.admin.${...}`) in both locales", () => {
    // Tab names, activity periods, terms, types, statuses, lifecycle values
    // and history actions reach t() as computed keys; they must all exist.
    for (const key of [
      "today", "month", "year", "identity", "members", "devices", "integrations",
      "activity", "history", "monthly", "yearly", "custom", "free", "paid",
      "active", "suspended", "deleted", "pending", "approved", "rejected", "all",
      "save", "renew", "extend", "reactivate", "cancel_at_end", "revoke",
    ]) resolvesInBothLocales(key);
  });

  it("covers the table-header keys the old fallback path silently dropped", () => {
    // Members/installations/jobs tables fell through to a("email")/a("role")/
    // a("id"), which had no catalogue entries and rendered "Text unavailable".
    for (const key of ["email", "role", "id"]) resolvesInBothLocales(key);
    expect(translate("en", "v4.admin.email")).toBe("Email");
    expect(translate("en", "v4.admin.role")).toBe("Role");
    expect(translate("en", "v4.admin.id")).toBe("ID");
  });

  it("gives the operations cards a description in both locales", () => {
    for (const key of ["operationsDescDevices", "operationsDescJobs", "operationsDescIntegrations"]) {
      resolvesInBothLocales(key);
    }
    expect(translate("en", "v4.admin.operationsDescDevices")).toBe("See all printers and agents");
    expect(translate("ar", "v4.admin.operationsDescDevices")).toBe("عرض جميع الطابعات والأجهزة");
  });

  it("keeps ManualAdmin as a helper module with no copy indirection", () => {
    const source = fs.readFileSync("src/components/platform/ManualAdmin.tsx", "utf8");
    expect(source).not.toMatch(/const a=useCallback/);
    expect(source).toContain("AdminStatus");
    expect(source).toContain("adminJson");
    // AdminStatus itself now resolves through t().
    expect(source).toMatch(/AdminStatus.*t\(`v4\.admin\.\$\{status\}`/s);
  });

  it("leaves the Settings security section reachable without any reauth branch", () => {
    const source = fs.readFileSync("src/app/settings/page.tsx", "utf8");
    expect(source).not.toContain("reauth");
    expect(source).toContain("<details");
    expect(source).toContain("SessionInventory");
  });
});
