import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");
const caddy = readFileSync("Caddyfile", "utf8");
const windowsWorkflow = readFileSync(".github/workflows/build-windows.yml", "utf8");
const nsisHooks = readFileSync("src-tauri/installer_hooks.nsh", "utf8");
const agentMain = readFileSync("agent/cmd/agent/main.go", "utf8");
const runtimeSecret = readFileSync("src/lib/runtime-secret.ts", "utf8");
const server = readFileSync("server.ts", "utf8");

describe("deployment security contracts", () => {
  it("mounts production secrets as Compose secrets instead of service environment values", () => {
    expect(compose).toContain("POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password");
    expect(compose).toContain("GATEWAY_JWT_SECRET_FILE: /run/secrets/gateway_jwt_secret");
    expect(compose).toContain("MANAGER_PASSWORD_HASH_FILE: /run/secrets/manager_password_hash");
    expect(compose).toContain("TRUST_PROXY_SECRET_FILE: /run/secrets/trust_proxy_secret");
    expect(compose).toMatch(/services:[\s\S]*postgres:[\s\S]*secrets:\s+- postgres_password/);
    expect(compose).toMatch(/services:[\s\S]*migrate:[\s\S]*secrets:\s+- postgres_password/);
    expect(compose).toMatch(/services:[\s\S]*gateway:[\s\S]*secrets:\s+- postgres_password[\s\S]*- gateway_jwt_secret[\s\S]*- manager_password_hash[\s\S]*- trust_proxy_secret/);
    expect(compose).not.toContain("PGPASSWORD: ${POSTGRES_PASSWORD");
    expect(compose).not.toContain("GATEWAY_JWT_SECRET: ${GATEWAY_JWT_SECRET");
    expect(compose).not.toContain("MANAGER_PASSWORD_HASH: ${MANAGER_PASSWORD_HASH");
  });

  it("supports file-backed secrets with explicit environment fallback for development", () => {
    expect(runtimeSecret).toContain("${name}_FILE");
    expect(runtimeSecret).toContain("readFileSync(file, \"utf8\")");
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
    expect(server).toContain('split("?", 1)[0]');
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
    // Elevated machine uninstall cannot safely enumerate or delete user
    // profiles. Keep strict service/install/ProgramData checks, and expose
    // per-user residual state instead of pretending it was removed.
    expect(windowsWorkflow).toContain("NSIS uninstall left the YaseirAgent Windows service behind");
    expect(windowsWorkflow).toContain("NSIS uninstall left files behind in");
    expect(windowsWorkflow).toContain("NSIS uninstall left shared runtime data behind:");
    expect(windowsWorkflow).toContain("NSIS uninstall left per-user state outside its owned machine cleanup scope:");
    expect(windowsWorkflow).toContain("NSIS machine uninstall verified: owned service, install files, and ProgramData removed; per-user cleanup remains separate.");
    expect(windowsWorkflow).not.toContain("current-user data are removed.");
    expect(nsisHooks).toContain("only the current uninstall caller's product-");
    expect(nsisHooks).toContain("checking for reparse roots");
    expect(nsisHooks).toContain("must never recurse over other accounts or HKCU keys.");
  });

  it("keeps the Windows workflow read-only and immutable", () => {
    expect(windowsWorkflow).toMatch(/permissions:\s*\n\s+contents:\s+read/);
    expect(windowsWorkflow).not.toMatch(/permissions:\s*[\s\S]*contents:\s+write/);
    expect(windowsWorkflow).not.toContain("git push");
    expect(windowsWorkflow).not.toContain("git commit");
    expect(windowsWorkflow).toContain("cargo metadata --locked --no-deps");
  });
});
