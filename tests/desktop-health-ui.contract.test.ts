import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop attention counts include unknown and stale printers", () => {
  it("Agents fleet stat never reports ok with only unknown/stale printers", () => {
    const agents = readFileSync("src/desktop/pages/Agents.tsx", "utf8");
    expect(agents).toContain("printerHealthCounts(physical, s.nowMs)");
    expect(agents).toContain("const attention = offline + unknown;");
  });

  it("Overview printer stat surfaces unknown printers instead of ok", () => {
    const overview = readFileSync("src/desktop/pages/Overview.tsx", "utf8");
    expect(overview).toContain("offline + unknownPrinters");
    // Keyboard focus must stay visible on the printer row button.
    expect(overview).not.toContain("focus:outline-none");
    expect(overview).toContain("focus-visible:ring-");
  });
});

describe("system health uses locale time, bounded fetch, status-aware errors", () => {
  it("relativeTime follows the active locale with an English-only fallback", () => {
    const client = readFileSync("src/app/system-health/system-health-client.tsx", "utf8");
    expect(client).toContain("new Intl.RelativeTimeFormat");
    expect(client).toContain("ar-u-nu-latn");
    expect(client).toContain("rtf.format(-seconds");
    expect(client).toContain("function relativeTime(iso: string, locale: string)");
    expect(client).not.toContain("`${minutes}m ago`");
    expect(client).not.toContain('"just now"');
  });

  it("health fetch is bounded and maps 401/403 instead of blaming the gateway", () => {
    const client = readFileSync("src/app/system-health/system-health-client.tsx", "utf8");
    expect(client).toContain("new AbortController()");
    expect(client).toContain("statusMessageKey(res.status)");
  });
});
