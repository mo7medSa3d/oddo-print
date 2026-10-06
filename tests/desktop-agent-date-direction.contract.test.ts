import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop Agent date direction contract", () => {
  it("does not force the localized Agent last-check date into LTR monospace", () => {
    const source = readFileSync("src/desktop/pages/Agents.tsx", "utf8");

    expect(source).toContain('label: t("desktop.agents.lastCheck")');
    expect(source).toContain('<span dir="auto"');
    expect(source).toContain('[unicode-bidi:isolate]');
    expect(source).not.toContain('<Mono>{s.lastStatusCheck ? formatDateTime(s.lastStatusCheck) : "—"}</Mono>');
  });
});
