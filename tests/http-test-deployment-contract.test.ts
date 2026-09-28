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

  it("binds the HTTP listener locally while routing the public IPv4 through the Host header", () => {
    const compose = read("deploy/http-test/docker-compose.yml");
    const caddy = read("deploy/http-test/Caddyfile");
    const setup = read("deploy/http-test/setup-http-test.sh");
    const env = read("deploy/http-test/.env.test.example");

    expect(compose).toContain('"${HTTP_TEST_BIND_IP}:${HTTP_TEST_PORT}:80"');
    expect(compose).toContain('HTTP_TEST_HOST: ${HTTP_TEST_HOST}');
    expect(compose).toContain(':80"');
    expect(caddy).toContain("@gateway_host host {$HTTP_TEST_HOST} {$HTTP_TEST_HOST}:{$HTTP_TEST_PORT}");
    expect(caddy).toContain('respond "Yasser HTTP test Gateway is available only through the configured server IP." 421');
    expect(setup).toContain('HTTP_TEST_HOST="$PUBLIC_IP"');
    expect(setup).toContain('HTTP_TEST_BIND_IP="0.0.0.0"');
    expect(setup).toContain('HTTP_TEST_BIND_IP="127.0.0.1"');
    expect(setup).toContain('curl -fsS --max-time 10 -H "Host: $HTTP_TEST_HOST"');
    expect(setup).toContain("SERVER_PUBLIC_IP must be an IPv4 address");
    expect(env).toContain("HTTP_TEST_BIND_IP=AUTO-DETECTED-LISTEN-ADDRESS");
    expect(env).toContain("HTTP_TEST_HOST=AUTO-DETECTED-PUBLIC-IP");
    expect(env).toContain("APP_BASE_URL=http://AUTO-DETECTED-PUBLIC-IP");
  });

  it("requires the Windows HTTP test helper to use an IPv4 Gateway address", () => {
    const helper = read("deploy/http-test/windows-agent-http-test.ps1");
    expect(helper).toContain("[System.Net.IPAddress]::Parse($uri.Host)");
    expect(helper).toContain("[System.Net.Sockets.AddressFamily]::InterNetwork");
    expect(helper).toContain('ServerUrl must use the staging server IPv4 address, not a hostname.');
    expect(helper).toContain("http://IP[:port]");
    // The Agent config contract accepts HTTP directly on this isolated
    // staging branch because the Windows service does not inherit the Manager
    // shell environment.
    const agentConfig = read("agent/internal/config/config.go");
    expect(agentConfig).toContain('case "https", "http":');
    expect(agentConfig).not.toContain("YASSER_AGENT_ALLOW_INSECURE_HTTP");
    expect(helper).not.toContain("YASSER_AGENT_ALLOW_INSECURE_HTTP");
    expect(helper).toContain("gateway-request");
  });

  it("keeps the pairing code contract one-time and rate-limited instead of weakening it for HTTP test mode", () => {
    const auth = read("src/lib/agent-auth.ts");
    const register = read("src/app/api/agent/register/route.ts");
    expect(auth).toContain("PAIRING_CODE_LENGTH = 6");
    expect(register).toContain("reservePairingAttempt");
    expect(register).toContain("pairing_code_expires_at > clock_timestamp()");
    expect(register).toContain("SET pairing_code_hash = NULL");
  });

  it("renders the pairing code with its expiry without changing its wire format", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    // Wire contract (matches the agent-create API + smoke assertions): the
    // pairing code and its expiry are displayed from the creation response.
    // Visual styling is main-owned; this test pins behavior, not pixels.
    expect(dashboard).toContain("activePairing.code");
    expect(dashboard).toContain("activePairing.expiresAt");
    expect(dashboard).toContain("formatCountdown");
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

  it("uses workspace authentication for post-verification onboarding", () => {
    const route = read("src/app/api/onboarding/route.ts");
    expect(route).toContain("validateWorkspaceManager(req)");
    expect(route).not.toContain("validateManager(req)");
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
