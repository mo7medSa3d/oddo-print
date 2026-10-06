import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop Agent date direction contract", () => {
  it("does not force localized Agent date/time values into LTR monospace", () => {
    const agents = readFileSync("src/desktop/pages/Agents.tsx", "utf8");
    const overview = readFileSync("src/desktop/pages/Overview.tsx", "utf8");

    expect(agents).toContain('label: t("desktop.agents.lastCheck")');
    expect(agents).toContain('<span dir="auto"');
    expect(agents).toContain('[unicode-bidi:isolate]');
    expect(agents).not.toContain('<Mono>{s.lastStatusCheck ? formatDateTime(s.lastStatusCheck) : "—"}</Mono>');

    expect(overview).toContain('label: t("desktop.overview.lastCheck")');
    expect(overview).toContain('<span dir="auto"');
    expect(overview).toContain('[unicode-bidi:isolate]');
    expect(overview).not.toContain('<Mono>{s.lastStatusCheck ? formatTime(s.lastStatusCheck) : "—"}</Mono>');
  });
});
