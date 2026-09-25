import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("debugging / robustness contracts", () => {
  it("keeps the Phase 2 decision points free of any and uses unknown-safe catch handling", () => {
    const typedFiles = [
      "src/app/api/auth/verify-email/route.ts",
      "src/app/api/printers/[id]/certify/route.ts",
      "src/lib/job-timeline.ts",
      "src/app/api/jobs/[id]/timeline/route.ts",
    ];
    for (const path of typedFiles) {
      const source = read(path);
      expect(source).not.toMatch(/:\s*any\b/);
    }

    for (const path of [
      "src/components/JobTimeline.tsx",
      "src/components/PrintCertificationWizard.tsx",
      "src/app/api-keys/page.tsx",
      "src/app/system-health/system-health-client.tsx",
    ]) {
      const source = read(path);
      expect(source).not.toMatch(/catch\s*\([^)]*:\s*any\)/);
      expect(source).toContain("e instanceof Error ? e.message : String(e)");
    }
  });

  it("keeps verification-email role handling fail-closed and typed", () => {
    const source = read("src/app/api/auth/verify-email/route.ts");
    expect(source).toContain('let role: ManagerRole = "owner";');
    expect(source).toContain("isManagerRole(existing[0].role)");
    expect(source).toContain('throw new Error("INVALID_TENANT_ROLE")');
    expect(source).not.toMatch(/let role:\s*any/);
  });

  it("keeps WebSocket teardown failures observable at debug level", () => {
    const log = read("src/lib/log.ts");
    const ws = read("src/server/ws.ts");
    expect(log).toContain('"debug" | "info" | "warn" | "error"');
    expect(log).toContain("console.debug(text)");
    expect(log).toContain("export function logDebug");
    expect(ws).toContain('import { logDebug, logInfo, logWarn }');
    expect(ws).not.toMatch(/catch\s*\{\s*\}/);
  });

  it("keeps the concrete Phase 4 operational failures checked", () => {
    expect(read("agent/cmd/cli/gateway.go")).toContain("write Gateway response failed");
    expect(read("agent/internal/queue/queue.go")).toContain("queue SQLite pragma failed");
    expect(read("agent/internal/queue/queue.go")).toContain("duplicate column name");
    expect(read("agent/internal/printer/network.go")).toContain("set printer write deadline");
    expect(read("agent/internal/printer/discovery_extended.go")).toContain("conn.Write([]byte(\"\\x04raw\\n\"))");
    expect(read("agent/internal/agent/agent.go")).toContain("job rejection callback failed");
    expect(read("agent/internal/agent/discovery_manager.go")).toContain("gateway response drain failed");
    expect(read("agent/internal/printer/ipp_discovery.go")).toContain("mDNS Browse failed");
    expect(read("agent/cmd/agent/main.go")).toContain("failed to close queue");
    expect(read("agent/internal/agent/desired_state.go")).toContain("failed to persist desired-state error");
    expect(read("agent/internal/printer/health.go")).toContain("set printer health deadline");
    expect(read("agent/internal/printer/wsd_discovery.go")).toContain("set WSD read deadline");
    expect(read("agent/internal/printer/registry.go")).toContain("if err := saveRegistryLocked(registryPath, all); err != nil");
    expect(read("agent/internal/printer/classify_device.go")).toContain("isVirtual is not relevant");
    expect(read("agent/internal/printer/discovery.go")).toContain("failed to enumerate addresses");
    expect(read("agent/internal/printer/network_discovery.go")).toContain("skipping malformed TCP target");
    expect(read("agent/internal/payload/payload.go")).toContain("requiredStringField");
  });
});
