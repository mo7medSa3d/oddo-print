import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("desktop Agent Gateway response contract", () => {
  it("preserves the real HTTP status from the CLI/Rust bridge", () => {
    const rust = read("src-tauri/src/commands.rs");
    const ipc = read("src/desktop/lib/ipc.ts");
    const cli = read("agent/cmd/cli/gateway.go");

    expect(cli).toContain("Status uint16");
    expect(cli).toContain("Body   string");
    expect(rust).toContain("let response: GatewayResponse = serde_json::from_str");
    expect(ipc).toContain("response.status");
    expect(ipc).not.toContain("return { status: 200, body: responseBody }");
  });

  it("routes physical Test Print through the manager-authenticated Gateway transport", () => {
    const main = read("src/desktop/main.tsx");
    const ipc = read("src/desktop/lib/ipc.ts");
    const rust = read("src-tauri/src/commands.rs");
    const cli = read("agent/cmd/cli/gateway.go");
    expect(main).toContain("testGatewayPrinter(savedGatewayUrl, id, key)");
    expect(main).not.toContain("testPrinter(id)");
    expect(ipc).toContain('"/api/printers/" + encodeURIComponent(printerId) + "/test-print"');
    const testPrintBlock = ipc.slice(ipc.indexOf("export async function testGatewayPrinter"), ipc.indexOf("export function cleanupLocalJobs"));
    expect(testPrintBlock).toContain("await gatewayRequest(");
    expect(testPrintBlock).not.toContain("gatewayConsoleRequest(");
    expect(rust).not.toContain('gateway_printer_action_path(path, "test-print")');
    expect(cli).toContain('gatewayPrinterActionPathRe = regexp.MustCompile("^/api/printers/[A-Za-z0-9._~-]+/test-connection$")');
  });

  it("normalizes Gateway printer config metadata for the desktop model", () => {
    const ipc = read("src/desktop/lib/ipc.ts");
    expect(ipc).toContain("config.address");
    expect(ipc).toContain("config.spooler_name");
    expect(ipc).toContain("config.vid");
    expect(ipc).toContain("config.pid");
  });

  it("keeps Gateway URL verification compatible with pre-probe Gateway deployments", () => {
    const ipc = read("src/desktop/lib/ipc.ts");
    const rust = read("src-tauri/src/commands.rs");

    expect(ipc).toContain("browserResponse.status === 404 || browserResponse.status === 405");
    expect(ipc).toContain("${base}/api/health");
    expect(rust).toContain("reqwest::StatusCode::NOT_FOUND");
    expect(rust).toContain("reqwest::StatusCode::METHOD_NOT_ALLOWED");
    expect(rust).toContain('.join("api/health")');
    expect(rust).toContain('"service":"yaseir-print-gateway"');
  });

  it("allows the bare jobs endpoint while rejecting malformed query pairs", () => {
    const source = read("agent/cmd/cli/gateway.go");
    expect(source).toContain('if parsed.RawQuery == "" {');
    expect(source).toContain('pair == "" || !strings.Contains(pair, "=")');
  });
});

  it("keeps printer control-plane mutations manager-only", () => {
    const route = read("src/app/api/printers/[id]/route.ts");
    const rust = read("src-tauri/src/commands.rs");
    const cli = read("agent/cmd/cli/gateway.go");
    const printersRoute = read("src/app/api/printers/route.ts");

    expect(route).toContain('if (auth.kind !== "manager")');
    expect(rust).not.toContain('"PATCH" => {');
    expect(cli).not.toContain('case "PATCH":');
    expect(printersRoute).toContain('managementSource: auth.kind === "manager" ? "manager" : "agent"');
  });
