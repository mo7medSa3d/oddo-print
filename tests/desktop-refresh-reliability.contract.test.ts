import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
describe("desktop paired Agent security", () => {
  it("keeps HTTPS origin matching and Agent print replay guard", () => {
    const rust=readFileSync("src-tauri/src/commands.rs","utf8");
    const gateway=readFileSync("agent/cmd/cli/gateway.go","utf8");
    expect(rust).toContain('normalize_gateway_url(&args.expected_origin)');
    expect(rust).toContain('.arg("gateway-request")');
    expect(rust).toContain("printer test-print requires an idempotency key");
    expect(gateway).toContain("gatewayTestPrintPathRe");
    expect(gateway).toContain("CheckRedirect:");
  });
});
