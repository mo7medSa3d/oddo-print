import { describe, expect, it, vi, afterEach } from "vitest";
import { logDebug, logInfo, currentLogLevel } from "../src/lib/log";

describe("log level gate (I-2)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("defaults to debug in development, info otherwise", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LOG_LEVEL", "");
    expect(currentLogLevel()).toBe("debug");
    vi.stubEnv("NODE_ENV", "production");
    expect(currentLogLevel()).toBe("info");
  });
  it("suppresses debug lines when level is info or higher", () => {
    vi.stubEnv("LOG_LEVEL", "info");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      logDebug("test.suppressed", {});
      expect(debugSpy).not.toHaveBeenCalled();
      logInfo("test.emitted", {});
      expect(infoSpy).toHaveBeenCalledTimes(1);
    } finally {
      debugSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
