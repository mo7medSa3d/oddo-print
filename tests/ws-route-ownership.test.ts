import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("agent WebSocket route ownership", () => {
  it("clears the WebSocket upgrade budget after successful authentication", () => {
    const source = readFileSync("src/lib/ws-rate-limit.ts", "utf8");
    const wsSource = readFileSync("src/server/ws.ts", "utf8");
    expect(source).toContain("export async function recordWsUpgradeSuccess");
    expect(source).toContain("DELETE FROM auth_rate_limits");
    expect(wsSource).toContain("recordWsUpgradeSuccess(clientKey)");
  });

  it("keeps the /api/agent/ws path exclusively on the custom HTTP upgrade server", () => {
    expect(existsSync("src/app/api/agent/ws/route.ts")).toBe(false);
    const serverSource = readFileSync("server.ts", "utf8");
    const wsSource = readFileSync("src/server/ws.ts", "utf8");
    expect(serverSource).toContain("attachAgentWSS(server)");
    expect(wsSource).toContain('server.on("upgrade"');
    expect(wsSource).toContain('new WebSocketServer({ noServer: true');
  });
});
