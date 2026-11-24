import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");
const caddy = readFileSync("Caddyfile", "utf8");
const windowsWorkflow = readFileSync(".github/workflows/build-windows.yml", "utf8");
const nsisHooks = readFileSync("src-tauri/installer_hooks.nsh", "utf8");
const agentMain = readFileSync("agent/cmd/agent/main.go", "utf8");
const runtimeSecret = readFileSync("src/lib/runtime-secret.ts", "utf8");
const server = readFileSync("server.ts", "utf8");
const service = (name: string) => compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|^volumes:)`, "m"))?.[1] ?? "";

describe("deployment security contracts", () => {
  it("keeps metrics machine access opt-in and mounts its file only in the Gateway", () => {
    const overlay = readFileSync("docker-compose.metrics.yml", "utf8");
    expect(compose).not.toContain("METRICS_SCRAPE_TOKEN");
    expect(overlay).toContain("METRICS_SCRAPE_TOKEN_FILE: /run/secrets/metrics_scrape_token");
    expect(overlay).toContain("file: ${METRICS_SCRAPE_TOKEN_FILE:?");
    expect(overlay).not.toMatch(/environment: METRICS_SCRAPE_TOKEN/);
    const services = overlay.split("services:\n")[1].split(/^secrets:/m)[0];
    expect(services.match(/^  [a-z_]+:/gm)).toEqual(["  gateway:"]);
    const guard = server.indexOf("assertMetricsMachineConfiguration();");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(server.indexOf("app.prepare()"));
    expect(server).toContain('import { assertMetricsMachineConfiguration } from "./src/lib/metrics-machine-auth"');
  });
  it("mounts production secrets as Compose secrets instead of service environment values", () => {
    expect(compose).toContain("POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password");
    expect(compose).toContain("GATEWAY_JWT_SECRET_FILE: /run/secrets/gateway_jwt_secret");
    expect(compose).toContain("MANAGER_PASSWORD_HASH_FILE: /run/secrets/manager_password_hash");
    expect(compose).toContain("TRUST_PROXY_SECRET_FILE: /run/secrets/trust_proxy_secret");
    expect(compose).toMatch(/services:[\s\S]*postgres:[\s\S]*secrets:\s+- postgres_password/);
    expect(service("database_roles")).toContain("- postgres_password");
    expect(service("migrate")).toContain("- postgres_owner_password");
    expect(service("gateway")).toMatch(/secrets:\s+- postgres_runtime_password[\s\S]*- gateway_jwt_secret[\s\S]*- manager_password_hash[\s\S]*- trust_proxy_secret/);
    expect(compose).not.toContain("PGPASSWORD: ${POSTGRES_PASSWORD");
    expect(compose).not.toContain("GATEWAY_JWT_SECRET: ${GATEWAY_JWT_SECRET");
    expect(compose).not.toContain("MANAGER_PASSWORD_HASH: ${MANAGER_PASSWORD_HASH");
  });

  it("separates bootstrap, migration ownership and runtime authority before serving requests", () => {
    for (const name of ["gateway", "database_verify"]) {
      expect(service(name)).toContain("PGUSER: ${POSTGRES_RUNTIME_USER:-yaseir_runtime}");
      expect(service(name)).toContain("PGPASSWORD_FILE: /run/secrets/postgres_runtime_password");
      expect(service(name)).not.toContain("postgres_owner_password");
      expect(service(name)).not.toMatch(/(?:\/run\/secrets\/| - )postgres_password\b/);
    }
    expect(service("migrate")).toContain("PGUSER: ${POSTGRES_OWNER_USER:-yaseir_owner}");
    expect(service("migrate")).not.toMatch(/(?:\/run\/secrets\/| - )postgres_password\b/);
    expect(service("gateway")).toContain("database_verify:");
    expect(service("database_verify")).toContain('"verify-runtime"');
    expect(service("database_roles")).toContain("role_state:/var/lib/yaseir-role-state");
    expect(service("gateway")).not.toContain("role_state");
  });

  it("supports file-backed secrets with explicit environment fallback for development", () => {
    expect(runtimeSecret).toContain("${name}_FILE");
    expect(runtimeSecret).toContain("readFileSync(file, \"utf8\")");
  });

  it("runs the TLS edge as its dedicated UID with no capabilities and loopback-only administration", () => {
    const edge = service("caddy");
    expect(edge).toContain('user: "10001:10001"');
    expect(edge).toMatch(/cap_drop:\s+- ALL/);
    expect(edge).not.toContain("cap_add:");
    expect(edge).toContain("no-new-privileges:true");
    expect(edge).toContain('net.ipv4.ip_unprivileged_port_start: "0"');
    expect(caddy).toContain("admin 127.0.0.1:2019");
    const secureImages = readFileSync("Dockerfile.secure-images", "utf8");
    const finalCaddy = secureImages.slice(secureImages.indexOf("FROM ${CADDY_BASE} AS caddy"));
    expect(finalCaddy).toContain("USER 10001:10001");
    expect(finalCaddy).toContain("chown -R 10001:10001 /data /config");
    expect(finalCaddy).toContain("http://127.0.0.1:2019/config/apps/http/servers/");
  });

  it("requires an authenticated proxy token whenever TRUST_PROXY is enabled", () => {
    expect(server).toContain("isTrustedProxyRequest");
    expect(server).toContain("TRUSTED_PROXY_REQUIRED");
    expect(server).toContain("TRUST_PROXY_SECRET");
    expect(caddy).toContain("header_up X-Gateway-Proxy-Token {file./run/secrets/trust_proxy_secret}");
    // The edge overwrites X-Forwarded-For with the real client address so
    // spoofed leftmost entries cannot rotate per-IP rate-limit buckets; the
    // Gateway additionally prefers the last valid entry.
    expect(caddy).toContain("header_up X-Forwarded-For {http.request.remote.host}");
    expect(caddy).toContain("per-IP rate-limit buckets");
    expect(caddy).toContain("header_up -X-Real-Ip");
  });

  it("exempts liveness probes by pathname so query strings cannot change the proxy gate (S-4)", () => {
    expect(server).toContain("requestPath(req.url)");
    expect(server).not.toMatch(/req\.url !== "\/api\/health"/);
  });

  it("keeps the NSIS Agent service lifecycle safe and preserves legacy config selection", () => {
    // NSIS is the single CI-produced Windows installer. Keep the lifecycle
    // contract focused on the package we actually ship instead of forcing an
    // unused MSI build back into the slow Windows workflow.
    expect(windowsWorkflow).toContain("Build Tauri Windows NSIS installer");
    expect(windowsWorkflow).not.toContain("Build Tauri Windows installer (MSI + NSIS EXE)");
    expect(nsisHooks).toContain('"$1" -service install');
    expect(nsisHooks).not.toContain('-service install -config');
    expect(nsisHooks).not.toContain('sc.exe" delete YasserAgent');
    expect(nsisHooks).not.toContain('sc.exe" delete OdooPrintAgent');
    expect(nsisHooks).toContain("YASEIR_STOP_OWNED_SERVICE_VERIFY");
    expect(nsisHooks).toContain("BINARY_PATH_NAME");
    expect(agentMain).toContain("verifyCurrentAgentServiceOwnershipIfPresent");
    expect(agentMain).toContain("serviceRemovalAlreadyComplete(err)");
    expect(agentMain).toContain("serviceRemovalAlreadyComplete(statusErr)");
    expect(readFileSync("agent/cmd/agent/service_install_windows.go", "utf8")).toContain("windows.ERROR_SERVICE_MARKED_FOR_DELETE");
    expect(agentMain).toContain('YaseirAgent service is already uninstalled');
    expect(windowsWorkflow).toContain('NSIS did not install the YaseirAgent Windows service');
    expect(windowsWorkflow).toContain('NSIS service did not preserve the legacy config path');
    expect(windowsWorkflow).toContain('NSIS uninstall verified: service, install files, ProgramData, and current-user data are removed.');
  });

  it("keeps the Windows workflow read-only and immutable", () => {
    expect(windowsWorkflow).toMatch(/permissions:\s*\n\s+contents:\s+read/);
    expect(windowsWorkflow).not.toMatch(/permissions:\s*[\s\S]*contents:\s+write/);
    expect(windowsWorkflow).not.toContain("git push");
    expect(windowsWorkflow).not.toContain("git commit");
    expect(windowsWorkflow).toContain("cargo metadata --locked --no-deps");
  });
});
