import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("paired-Agent desktop security contract", () => {
  it("never stores or asks for a Gateway Manager account in the installed desktop", () => {
    const settings=read("src/desktop/pages/Settings.tsx");
    const ipc=read("src/desktop/lib/ipc.ts");
    const rust=read("src-tauri/src/commands.rs");
    const app=read("src/desktop/main.tsx");
    const handler=read("src-tauri/src/main.rs");
    expect(settings).not.toContain("ManagerAccountPanel");
    expect(ipc).not.toContain("loginManager");
    expect(ipc).not.toContain("gateway_request");
    expect(rust).not.toContain("ManagerSession");
    expect(handler).not.toContain("commands::gateway_request,");
    expect(app).not.toContain("managerCanManage");
    expect(app).not.toContain('diagnosticScope(savedGatewayUrl, "paired-agent", id)');
    expect(app).not.toContain("testGatewayPrinter(");
  });

  it("routes Agent inventory and diagnostics through the paired CLI, never an arbitrary bearer", () => {
    const ipc=read("src/desktop/lib/ipc.ts");
    const rust=read("src-tauri/src/commands.rs");
    const gateway=read("agent/cmd/cli/gateway.go");
    expect(ipc).toContain('invoke<string>("gateway_agent_request"');
    expect(ipc).toContain('idempotency_key: idempotencyKey ?? null');
    expect(rust).toContain('.arg("gateway-request")');
    expect(rust).toContain('gateway_printer_action_path(&path, "test-print")');
    expect(gateway).toContain('req.Header.Set("Authorization", "Bearer "+cfg.Agent.ID+":"+cfg.Agent.Secret)');
    expect(gateway).toContain("gatewayTestPrintPathRe");
  });

  it("enforces the branch-specific Gateway transport contract", () => {
    const commands = read("src-tauri/src/commands.rs");
    expect(commands).not.toContain("Gateway URL must use HTTPS for remote Gateways");
    expect(commands).toContain("gateway URL cannot include embedded credentials");
    expect(commands).toContain("gateway URL must use http:// or https://");
  });

  it("restricts desktop mutations to local Agent IPC without removed cloud test-print routes", () => {
    const source=read("src/desktop/lib/ipc.ts");
    const gateway=read("agent/cmd/cli/gateway.go");
    expect(source).toContain('gatewayConsoleRequest(');
    // Gateway is License-Only: removed cloud /api/printers/.../test-print routes
    // are replaced by the local Agent IPC test_printer command.
    expect(source).not.toContain('"/api/printers/" + encodeURIComponent(printerId) + "/test-print"');
    expect(source).toContain('invoke<string>("test_printer", { printerId })');
    expect(source).not.toContain("virtual_spooler_test");
    expect(gateway).not.toContain('case "PATCH":');
  });

  it("gateway CORS is explicit and never wildcarded", () => {
    const source = read("src/server/cors.ts");
    expect(source).toContain("DESKTOP_CORS_ORIGINS");
    expect(source).toContain("tauri://localhost");
    expect(source).toContain("http://tauri.localhost");
    expect(source).toContain("Access-Control-Allow-Headers");
    expect(source).not.toContain('"*"');
  });
});