import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("HTTP test deployment contracts", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("provisions every canonical plan entitlement in the isolated test catalog", () => {
    const setup = read("deploy/http-test/setup-http-test.sh");
    expect(setup).toContain('"max_agents":5');
    expect(setup).toContain('"max_printers":10');
    expect(setup).toContain('"max_jobs_per_minute":60');
    expect(setup).toContain('"max_concurrent_jobs":8');
    expect(setup).toContain('"max_prints_per_period":"unlimited"');
  });

  it("binds the isolated HTTP endpoint to the detected IPv4 and rejects other Hosts", () => {
    const compose = read("deploy/http-test/docker-compose.yml");
    const caddy = read("deploy/http-test/Caddyfile");
    const setup = read("deploy/http-test/setup-http-test.sh");
    const env = read("deploy/http-test/.env.test.example");

    expect(compose).toContain('"${HTTP_TEST_BIND_IP}:${HTTP_TEST_PORT}:80"');
    expect(compose).toContain('HTTP_TEST_HOST: ${HTTP_TEST_HOST}');
    expect(compose).toContain(':80"');
    expect(caddy).toContain("@gateway_host host {$HTTP_TEST_HOST}");
    expect(caddy).toContain('respond "Yasser HTTP test Gateway is available only through the configured server IP." 421');
    expect(setup).toContain('HTTP_TEST_BIND_IP=$PUBLIC_IP');
    expect(setup).toContain('HTTP_TEST_HOST=$PUBLIC_IP');
    expect(setup).toContain("SERVER_PUBLIC_IP must be an IPv4 address");
    expect(env).toContain("HTTP_TEST_BIND_IP=AUTO-DETECTED-PUBLIC-IP");
    expect(env).toContain("HTTP_TEST_HOST=AUTO-DETECTED-PUBLIC-IP");
    expect(env).toContain("APP_BASE_URL=http://AUTO-DETECTED-PUBLIC-IP");
  });

  it("requires the Windows HTTP test helper to use an IPv4 Gateway address", () => {
    const helper = read("deploy/http-test/windows-agent-http-test.ps1");
    expect(helper).toContain("[System.Net.IPAddress]::Parse($uri.Host)");
    expect(helper).toContain("[System.Net.Sockets.AddressFamily]::InterNetwork");
    expect(helper).toContain('ServerUrl must use the staging server IPv4 address, not a hostname.');
    expect(helper).toContain("http://IP[:port]");
    expect(helper).not.toContain("YASSER_AGENT_ALLOW_INSECURE_HTTP");
  });

  it("keeps the pairing code contract one-time and rate-limited instead of weakening it for HTTP test mode", () => {
    const auth = read("src/lib/agent-auth.ts");
    const register = read("src/app/api/agent/register/route.ts");
    expect(auth).toContain("PAIRING_CODE_LENGTH = 6");
    expect(register).toContain("reservePairingAttempt");
    expect(register).toContain("pairing_code_expires_at > clock_timestamp()");
    expect(register).toContain("SET pairing_code_hash = NULL");
  });

  it("makes the pairing code prominent without changing its wire format", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain("text-[30px]");
    expect(dashboard).toContain("sm:text-[32px]");
  });

  it("models the real Tauri origin for the desktop bearer-login smoke step", () => {
    const smoke = read("deploy/http-test/smoke-http-test.sh");
    expect(smoke).toContain("Origin: tauri://localhost");
    expect(smoke).toContain("X-Odoo-Print-Desktop: 1");
    expect(smoke).toContain('"${DESKTOP_HEADERS[@]}"');
    expect(smoke).toContain("Authorization: $AGENT_BEARER");
    expect(smoke).toContain("Upgrade: websocket");
    expect(smoke).toContain("$BASE/api/agent/ws");
  });
  it("has a blocking end-to-end HTTP transport workflow for this staging branch", () => {
    const workflow = read(".github/workflows/http-staging-transport.yml");
    expect(workflow).toContain("test/http-server-ready");
    expect(workflow).toContain("HTTP Gateway + Agent transport E2E");
    expect(workflow).toContain("SERVER_PUBLIC_IP: 127.0.0.1");
    expect(workflow).toContain("HTTP_TEST_PORT: 18080");
    expect(workflow).toContain("bash deploy/http-test/smoke-http-test.sh");
    expect(workflow).toContain("go test -mod=readonly ./internal/config");
  });

  it("requires explicit staging mode for the production HTTP exception", () => {
    const server = read("server.ts");
    expect(server).toContain('const httpTestMode = process.env.YASSER_HTTP_TEST_MODE === "1";');
    expect(server).not.toContain('process.env.YASSER_HTTP_TEST_MODE !== "0"');
  });

  it("passes the HTTP test login username into tenant resolution", () => {
    const route = read("src/app/api/auth/manager/login/route.ts");
    expect(route).toContain("resolveManagerTenantId(req, username)");
  });
});
