import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeSecret, __clearSecretCacheForTests } from "../src/lib/runtime-secret";

describe("runtime secret cache (S-7)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); __clearSecretCacheForTests(); });

  it("memoizes file reads and picks up rotation after the TTL", () => {
    const dir = mkdtempSync(join(tmpdir(), "yaseir-secret-"));
    const file = join(dir, "token");
    writeFileSync(file, "first-value");
    vi.stubEnv("TEST_CACHE_SECRET_FILE", file);
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    expect(runtimeSecret("TEST_CACHE_SECRET")).toBe("first-value");
    writeFileSync(file, "second-value");
    // Within TTL the cached value is served without another read.
    vi.setSystemTime(10_000);
    expect(runtimeSecret("TEST_CACHE_SECRET")).toBe("first-value");
    // After the 30s TTL the rotated file value is picked up.
    vi.setSystemTime(40_000);
    expect(runtimeSecret("TEST_CACHE_SECRET")).toBe("second-value");
  });

  it("serves only fresh cached authority on a missing file and recovers after repair", () => {
    const dir = mkdtempSync(join(tmpdir(), "yaseir-secret-expiry-"));
    const file = join(dir, "token");
    try {
      writeFileSync(file, "retired-value");
      vi.stubEnv("TEST_CACHE_SECRET_FILE", file);
      vi.stubEnv("TEST_CACHE_SECRET", "environment-must-not-override-file");
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      expect(runtimeSecret("TEST_CACHE_SECRET")).toBe("retired-value");
      unlinkSync(file);
      vi.setSystemTime(30_999);
      expect(runtimeSecret("TEST_CACHE_SECRET")).toBe("retired-value");
      vi.setSystemTime(31_000);
      expect(runtimeSecret("TEST_CACHE_SECRET")).toBeUndefined();
      vi.setSystemTime(120_000);
      expect(runtimeSecret("TEST_CACHE_SECRET")).toBeUndefined();
      writeFileSync(file, "repaired-value");
      expect(runtimeSecret("TEST_CACHE_SECRET")).toBe("repaired-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
