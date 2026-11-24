import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const mode of ["missing", "malformed"]) {
  test(`actual custom server refuses ${mode} configured metrics custody before listening`, { timeout: 15000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), "yaseir-metrics-startup-"));
    const file = join(directory, "collector-key");
    const privateMarker = `invalid-${randomBytes(24).toString("hex")}`;
    try {
      if (mode === "malformed") writeFileSync(file, privateMarker, { mode: 0o600 });
      const result = spawnSync(process.execPath, ["--import", "tsx", "server.ts"], {
        cwd: process.cwd(), encoding: "utf8", timeout: 12000,
        // No inherited database, human auth, provider or secret-file values.
        env: { PATH: process.env.PATH, NODE_ENV: "test", HOSTNAME: "127.0.0.1", PORT: "0", METRICS_SCRAPE_TOKEN_FILE: file },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1);
      const output = result.stdout + result.stderr;
      assert.match(output, /MetricsMachineConfigurationError/);
      assert.match(output, /Configured metrics credential must be a readable regular file/);
      assert.doesNotMatch(output, /Ready on|server\.listening/);
      assert.ok(!output.includes(privateMarker), "startup diagnostics must not expose the configured credential");
      assert.ok(!output.includes(file), "startup diagnostics must not expose the secret-file path");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
