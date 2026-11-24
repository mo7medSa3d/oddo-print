import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("desktop Agent Gateway response contract", () => {
  it("preserves the real HTTP status from the CLI/Rust bridge", () => {
    const rust = read("src-tauri/src/commands.rs");
    const ipc = read("src/desktop/lib/ipc.ts");
    const headers = read("src/desktop/lib/gateway-headers.ts");
    const cli = read("agent/cmd/cli/gateway.go");

    expect(cli).toMatch(/Status\s+uint16\s+`json:"status"`/);
    expect(cli).toMatch(/Body\s+string\s+`json:"body"`/);
    expect(cli).toMatch(/Headers\s+map\[string\]string\s+`json:"headers,omitempty"`/);
    expect(rust).toContain("let mut response: GatewayResponse = serde_json::from_str");
    expect(rust).toContain("response.headers.retain");
    expect(headers).toContain('"x-next-before-id-encoded"');
    expect(ipc).toContain("readGatewayPaginationHeaders");
    expect(ipc).toContain("response.status");
    expect(ipc).not.toContain("return { status: 200, body: responseBody }");
  });

  it("routes desktop test-print through local Agent IPC without removed cloud printer routes", () => {
    const main = read("src/desktop/main.tsx");
    const ipc = read("src/desktop/lib/ipc.ts");
    const rust = read("src-tauri/src/commands.rs");
    const cli = read("agent/cmd/cli/gateway.go");
    expect(main).not.toContain("testGatewayPrinter(");
    expect(main).not.toContain("testPrinter(id)");
    expect(ipc).not.toContain('"/api/printers/" + encodeURIComponent(printerId) + "/test-print"');
    const testPrintBlock = ipc.slice(ipc.indexOf("export async function testGatewayPrinter"), ipc.indexOf("export function cleanupLocalJobs"));
    expect(testPrintBlock).toContain('invoke<string>("test_printer", { printerId })');
    expect(testPrintBlock).not.toContain("await gatewayRequest(");
    expect(rust).toContain('gateway_printer_action_path(path, "test-print")');
    expect(cli).toContain("gatewayTestPrintPathRe");
    expect(cli).toContain('req.Header.Set("Authorization", "Bearer "+cfg.Agent.ID+":"+cfg.Agent.Secret)');
  });

  it("keeps printer management local to the Agent under the License-Only Gateway contract", () => {
    const ipc = read("src/desktop/lib/ipc.ts");
    expect(ipc).toContain("Gateway is a License-Only control plane; printers are managed locally by the Agent.");
    expect(ipc).toContain('invoke<unknown>("get_printers")');
    expect(ipc).toContain('invoke<unknown>("discover_printers")');
    expect(ipc).toContain('invoke<string>("register_printer", { request })');
  });

  it("allows the bare jobs endpoint while rejecting malformed query pairs", () => {
    const source = read("agent/cmd/cli/gateway.go");
    expect(source).toContain('if parsed.RawQuery == "" {');
    expect(source).toContain('rawKey, _, found := strings.Cut(pair, "=")');
    expect(source).toContain('if !found {');
  });

  it("removes legacy Gateway printer routes while keeping desktop CLI/Rust PATCH guards", () => {
    const rust = read("src-tauri/src/commands.rs");
    const cli = read("agent/cmd/cli/gateway.go");

    expect(existsSync(join(root, "src/app/api/printers/route.ts"))).toBe(false);
    expect(existsSync(join(root, "src/app/api/printers/[id]/route.ts"))).toBe(false);
    expect(rust).not.toContain('"PATCH" => {');
    expect(cli).not.toContain('case "PATCH":');
  });
});
