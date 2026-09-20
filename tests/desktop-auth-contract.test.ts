import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("desktop manager authentication contract", () => {
  it("login issues a bearer token only to the explicitly identified desktop client", () => {
    const source = read("src/app/api/auth/manager/login/route.ts");
    expect(source).toContain('req.headers.get("x-odoo-print-desktop") === "1"');
    expect(source).toContain("if (desktopClient) bodyOut.accessToken = sess.token;");
    expect(source).not.toContain("accessToken: sess.token");
  });

  it("desktop IPC uses Authorization bearer instead of cross-site credentials", () => {
    const source = read("src/desktop/lib/ipc.ts");
    expect(source).toContain("Authorization");
    expect(source).toContain("Bearer ${");
    expect(source).toContain('"X-Odoo-Print-Desktop": "1"');
    expect(source).not.toContain('credentials: "include"');
  });

  it("allows the isolated HTTP test branch to use a remote IP over HTTP", () => {
    const commands = read("src-tauri/src/commands.rs");
    expect(commands).toContain('if scheme == "http"');
    expect(commands).toContain("This isolated test branch intentionally accepts remote HTTP");
    expect(commands).toContain('cmd.env("YASSER_AGENT_ALLOW_INSECURE_HTTP", "1")');
    expect(commands).not.toContain("Gateway URL must use HTTPS for remote Gateways");
  });


  it("uses the paired Agent identity for packaged-console jobs instead of requiring Manager login", () => {
    const source = read("src/desktop/lib/ipc.ts");
    expect(source).toContain('invoke<string>("gateway_agent_request"');
    expect(source).toContain('"/api/jobs"');
    expect(source).toContain(`gatewayConsoleRequest(base, "/api/jobs"`);
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