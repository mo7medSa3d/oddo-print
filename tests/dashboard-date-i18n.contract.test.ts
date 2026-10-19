import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard localized date phrases", () => {
  it("renders usage reset dates through a single localized sentence", () => {
    const dashboard = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
    const en = readFileSync("src/i18n/messages/en.ts", "utf8");
    const ar = readFileSync("src/i18n/messages/ar.ts", "utf8");

    expect(dashboard).toContain('t("billing.resetsOnDate", { date: formatDate(prints.periodEnd) })');
    expect(dashboard).not.toContain('${t("billing.resetsOn")} ${formatDate(prints.periodEnd)}');
    expect(en).toContain('"billing.resetsOnDate": "Resets {date}"');
    expect(ar).toContain('"billing.resetsOnDate": "يُعاد الضبط في {date}"');
  });
});
