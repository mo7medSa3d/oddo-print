import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("desktop manager authentication contract", () => {
  it("login issues a bearer token only to the explicitly identified desktop client", () => {
    const source = read("src/app/api/auth/manager/login/route.ts");
    expect(source).toContain('req.headers.get("x-odoo-print-desktop") === "1"');
    expect(source).toContain("if (desktopClient)");
    expect(source).toContain("bodyOut.accessToken = sess.token;");
    expect(source).toContain("bodyOut.refreshToken = sess.refreshToken;");
    expect(source).toContain("if (!desktopClient)");
    expect(source).not.toContain("accessToken: sess.token");
  });

  it("desktop IPC keeps bearer authentication in Rust while browser fetch uses cookies", () => {
    const source = read("src/desktop/lib/ipc.ts");
    const rust = read("src-tauri/src/commands.rs");
    expect(source).toContain('"X-Odoo-Print-Desktop": "1"');
    expect(source).toContain('credentials: "include"');
    expect(source).not.toContain('"X-Refresh-Token"');
    expect(rust).toContain('request.bearer_auth(token)');
    expect(rust).toContain('request.header("X-Refresh-Token", refresh_token)');
    expect(rust).toContain('request = request.header("Origin", "tauri://localhost")');
  });

  it("enforces the branch-specific Gateway transport contract", () => {
    const commands = read("src-tauri/src/commands.rs");
    const testBranch = commands.includes("This isolated test branch intentionally accepts remote HTTP");
    if (testBranch) {
      expect(commands).toContain('let remote_http = scheme == "http";');
      expect(commands).toContain("This isolated test branch intentionally accepts remote HTTP");
      expect(commands).not.toContain("YASSER_AGENT_ALLOW_INSECURE_HTTP");
      expect(commands).toContain("gateway URL cannot include embedded credentials");
    } else {
      expect(commands).toContain('if scheme == "http"');
      expect(commands).toContain('let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");');
      expect(commands).toContain("Gateway URL must use HTTPS for remote Gateways");
    }
  });

  it("routes manager-owned printer mutations through the Manager transport", () => {
    const source = read("src/desktop/lib/ipc.ts");
    const updateFn = source.match(/export async function updateGatewayPrinter[\s\S]*?(?=\nexport interface DiscoverResult)/)?.[0] ?? "";
    expect(updateFn).toContain('await gatewayRequest(');
    expect(updateFn).not.toContain('await gatewayConsoleRequest(');
    expect(source).toContain('"/api/printers/" + encodeURIComponent(printerId)');
    expect(source).toContain('"PATCH"');
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