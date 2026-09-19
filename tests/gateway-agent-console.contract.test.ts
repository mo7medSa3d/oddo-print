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

  it("routes desktop printer tests through the Gateway console path", () => {
    const main = read("src/desktop/main.tsx");
    const ipc = read("src/desktop/lib/ipc.ts");
    expect(main).toContain("testGatewayPrinter(gatewayUrl, id)");
    expect(main).not.toContain("testPrinter(id)");
    expect(ipc).toContain('"/api/printers/" + encodeURIComponent(printerId) + "/test-print"');
  });

  it("normalizes Gateway printer config metadata for the desktop model", () => {
    const ipc = read("src/desktop/lib/ipc.ts");
    expect(ipc).toContain("config.address");
    expect(ipc).toContain("config.spooler_name");
    expect(ipc).toContain("config.vid");
    expect(ipc).toContain("config.pid");
  });

  it("allows the bare jobs endpoint while rejecting malformed query pairs", () => {
    const source = read("agent/cmd/cli/gateway.go");
    expect(source).toContain('if parsed.RawQuery == "" {');
    expect(source).toContain('pair == "" || !strings.Contains(pair, "=")');
  });
});
