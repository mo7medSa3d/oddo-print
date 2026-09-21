import { describe, it, expect } from "vitest";
import * as fs from "fs";

describe("windows-service-recovery", () => {
  it("service recovery config matches the real agent/toolchain registration", () => {
    const doc = fs.readFileSync("docs/WINDOWS_SERVICE_RECOVERY.md", "utf8");
    expect(doc).toContain("YasserAgent");
    expect(doc).toContain("86400");
    expect(doc).toContain("restart/60000");
    expect(doc).toContain("Spooler");
    expect(doc).toContain("Service Control Manager");
    // The documented service identity must match the code that actually
    // registers the service, or sc query/qfailure instructions fail on a
    // real Windows host.
    const mainGo = fs.readFileSync("agent/cmd/agent/main.go", "utf8");
    expect(mainGo).toContain('Name:         "YasserAgent"');
    expect(mainGo).toContain('"actions= restart/60000/restart/60000/restart/60000"');
  });

  it("service status API returns BLOCKED explicit with required fields", () => {
    const source = fs.readFileSync("src/app/api/agents/service-status/route.ts", "utf8");
    expect(source).toContain("serviceName");
    expect(source).toContain('serviceName: "YasserAgent"');
    expect(source).toContain("state");
    expect(source).toContain("startType");
    expect(source).toContain("recovery");
    expect(source).toContain("lastRestart");
    expect(source).toContain("failureCount");
    expect(source).toContain("exitCode");
    expect(source).toContain("BLOCKED");
    expect(source).toContain("Windows Service Control Manager");
    expect(source).not.toContain("YasserPrintAgent");
  });

  it("kill→SCM restart→reconnect test procedure documented", () => {
    const doc = fs.readFileSync("docs/WINDOWS_SERVICE_RECOVERY.md", "utf8");
    expect(doc).toContain("sc start");
    expect(doc).toContain("taskkill");
    expect(doc).toContain("sc query");
    expect(doc).toContain("failure count");
    expect(doc).toContain("Gateway");
    expect(doc).toContain("90s");
  });

  it("Tauri updater claims verified — no updater if not implemented", () => {
    // Check tauri.conf.json for updater
    const tauriConfPath = "src-tauri/tauri.conf.json";
    let hasUpdater = false;
    try {
      const conf = fs.readFileSync(tauriConfPath, "utf8");
      hasUpdater = conf.includes("updater") || conf.includes("plugins") && conf.includes("updater");
    } catch {
      hasUpdater = false;
    }
    const cargoPath = "src-tauri/Cargo.toml";
    let cargoHasUpdater = false;
    try {
      const cargo = fs.readFileSync(cargoPath, "utf8");
      cargoHasUpdater = cargo.includes("updater");
    } catch {
      cargoHasUpdater = false;
    }
    // If no updater found, it must be marked BLOCKED/NOT IMPLEMENTED, not claimed PASS
    const releaseReadiness = fs.readFileSync("src/app/release-readiness/release-readiness-client.tsx", "utf8");
    if (!hasUpdater && !cargoHasUpdater) {
      expect(releaseReadiness).toContain("Tauri updater");
      expect(releaseReadiness).toMatch(/BLOCKED|NOT IMPLEMENTED|FAIL/);
    }
  });

  it("BLOCKED handling explicit for sandbox", () => {
    const source = fs.readFileSync("src/app/api/agents/service-status/route.ts", "utf8");
    expect(source).toContain("BLOCKED");
    expect(source).toContain("requires Windows host");
  });
});
