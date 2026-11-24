// @vitest-environment jsdom
// WP-A (S1 classification + S2 device parser): pure unit tests, no database.
// The component import needs the same module mocks as
// tests/session-account-ui.test.ts; the parser/classifier themselves are
// pure functions with no network or storage access.
import { describe, expect, it, vi } from "vitest";
import { classifySessionAnomaly } from "../src/lib/session-tokens";

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/lib/fetch-timeout", () => ({ fetchWithTimeout: fixture.fetch, fetchWithSessionRetry: fixture.fetch }));
vi.mock("../src/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key, formatDate: (value: string) => value }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

import { parseDeviceLabel } from "../src/components/SessionInventory";

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("WP-A S1 anomaly classification (log-only, never blocking)", () => {
  it("returns no event when IP and user-agent are unchanged", () => {
    expect(classifySessionAnomaly(
      { ipAddress: "203.0.113.10", userAgent: CHROME_WINDOWS },
      { ipAddress: "203.0.113.10", userAgent: CHROME_WINDOWS },
    )).toBeNull();
  });

  it("classifies a changed IP as ip_changed", () => {
    expect(classifySessionAnomaly(
      { ipAddress: "203.0.113.10", userAgent: CHROME_WINDOWS },
      { ipAddress: "198.51.100.7", userAgent: CHROME_WINDOWS },
    )).toEqual({ kind: "ip_changed", ipChanged: true, deviceChanged: false });
  });

  it("classifies a changed user-agent as device_changed", () => {
    expect(classifySessionAnomaly(
      { ipAddress: "203.0.113.10", userAgent: CHROME_WINDOWS },
      { ipAddress: "203.0.113.10", userAgent: SAFARI_IPHONE },
    )).toEqual({ kind: "device_changed", ipChanged: false, deviceChanged: true });
  });

  it("emits a single ip_changed event when both IP and device change", () => {
    expect(classifySessionAnomaly(
      { ipAddress: "203.0.113.10", userAgent: CHROME_WINDOWS },
      { ipAddress: "198.51.100.7", userAgent: SAFARI_IPHONE },
    )).toEqual({ kind: "ip_changed", ipChanged: true, deviceChanged: true });
  });

  it("returns no event for the first token in a family (no previous context)", () => {
    expect(classifySessionAnomaly(null, { ipAddress: "198.51.100.7", userAgent: SAFARI_IPHONE })).toBeNull();
    expect(classifySessionAnomaly(undefined, { ipAddress: "198.51.100.7", userAgent: SAFARI_IPHONE })).toBeNull();
  });

  it("returns no event when there is no baseline or no incoming context", () => {
    expect(classifySessionAnomaly(
      { ipAddress: null, userAgent: null },
      { ipAddress: "198.51.100.7", userAgent: SAFARI_IPHONE },
    )).toBeNull();
    expect(classifySessionAnomaly(
      { ipAddress: "203.0.113.10", userAgent: CHROME_WINDOWS },
      { ipAddress: null, userAgent: null },
    )).toBeNull();
  });

  it("compares each field only when both sides carry it", () => {
    // Previous token stored an IP but no UA: an IP change still counts,
    // a newly seen UA alone does not invent a device change.
    expect(classifySessionAnomaly(
      { ipAddress: "203.0.113.10", userAgent: null },
      { ipAddress: "198.51.100.7", userAgent: SAFARI_IPHONE },
    )).toEqual({ kind: "ip_changed", ipChanged: true, deviceChanged: false });
    expect(classifySessionAnomaly(
      { ipAddress: "203.0.113.10", userAgent: null },
      { ipAddress: "203.0.113.10", userAgent: SAFARI_IPHONE },
    )).toBeNull();
  });
});

describe("WP-A S2 sessions-list device parser", () => {
  it("parses Chrome on Windows", () => {
    expect(parseDeviceLabel(CHROME_WINDOWS)).toBe("Chrome on Windows");
  });

  it("parses Safari on iPhone", () => {
    expect(parseDeviceLabel(SAFARI_IPHONE)).toBe("Safari on iPhone");
  });

  it("prefers Edge over the Chrome token Edge UAs also carry", () => {
    expect(parseDeviceLabel(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    )).toBe("Edge on Windows");
  });

  it("returns null for empty or unknown user-agents (caller falls back to security.unknownDevice)", () => {
    expect(parseDeviceLabel(null)).toBeNull();
    expect(parseDeviceLabel("")).toBeNull();
    expect(parseDeviceLabel("SomeBot/1.0 (+http://example.test/bot)")).toBeNull();
  });

  it("keeps the label short even for a very long user-agent", () => {
    const label = parseDeviceLabel(`${CHROME_WINDOWS} ${"x".repeat(5000)}`);
    expect(label).toBe("Chrome on Windows");
    expect(label!.length).toBeLessThan(40);
  });
});
