import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("desktop manager authentication contract", () => {
  it("login issues a bearer token only to the explicitly identified desktop client", () => {
    const source = read("src/app/api/auth/manager/login/route.ts");
    expect(source).toContain("isTrustedDesktopRequest(req)");
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
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("localStorage");
    expect(rust).toContain('request.bearer_auth(token)');
    expect(rust).toContain('request.header("X-Refresh-Token", refresh_token)');
    expect(rust).toContain('request = request.header("Origin", "tauri://localhost")');
  });

  it("allows the isolated HTTP test branch to use a remote IP over HTTP", () => {
    const commands = read("src-tauri/src/commands.rs");
    expect(commands).toContain('if scheme != "https" && scheme != "http"');
    expect(commands).toContain("gateway URL must use http:// or https://");
    expect(commands).toContain('cmd.env("YASEIR_AGENT_ALLOW_INSECURE_HTTP", "1")');
    expect(commands).not.toContain("Gateway URL must use HTTPS for remote Gateways");
  });

  it("uses the paired Agent identity for packaged-console jobs instead of requiring Manager login", () => {
    const source = read("src/desktop/lib/ipc.ts");
    expect(source).toContain('invoke<string>("gateway_agent_request"');
    expect(source).toContain("/api/jobs?");
    expect(source).toContain("const endpoint = `/api/jobs?\${params.toString()}`;");
    expect(source).toContain('gatewayConsoleRequest(base, endpoint, "GET", headers)');
    expect(source).not.toContain('gatewayRequest(base, "/api/jobs"');
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
