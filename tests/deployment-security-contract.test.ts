import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");
const caddy = readFileSync("Caddyfile", "utf8");
const windowsWorkflow = readFileSync(".github/workflows/build-windows.yml", "utf8");
const tauriConfig = readFileSync("src-tauri/tauri.conf.json", "utf8");
const nsisHooks = readFileSync("src-tauri/installer_hooks.nsh", "utf8");
const wixService = readFileSync("src-tauri/wix/service.wxs", "utf8");
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
    // Caddy's reverse_proxy sanitizes forwarded headers by default when no
    // trusted-proxy list is configured, so an explicit X-Forwarded-For rewrite
    // is neither necessary nor part of the production contract.
    expect(caddy).toContain("sanitizes X-Forwarded-* inputs");
    expect(caddy).not.toContain("header_up X-Forwarded-For");
    expect(caddy).toContain("header_up -X-Real-Ip");
  });

  it("keeps MSI and NSIS on the same Agent service lifecycle and preserves legacy config selection", () => {
    expect(tauriConfig).toContain('"./wix/service.wxs"');
    expect(wixService).toContain('YaseirStopExistingAgent');
    expect(wixService).toContain('net.exe stop YaseirAgent /y');
    expect(wixService).toContain('<Custom Action="YaseirStopExistingAgent" Before="InstallFiles">');
    expect(wixService).toContain('<Custom Action="YaseirInstallAgentService" After="YaseirDeleteLegacyOdooPrint">');
    expect(wixService.indexOf('<Custom Action="YaseirStopExistingAgent"')).toBeLessThan(
      wixService.indexOf('<Custom Action="YaseirInstallAgentService"'),
    );
    expect(wixService).toContain('YaseirInstallAgentService');
    expect(wixService).toContain('resources\\YaseirAgent.exe&quot; -service install');
    expect(wixService).toContain('YaseirUninstallAgentService');
    expect(nsisHooks).toContain('"$1" -service install');
    expect(nsisHooks).not.toContain('-service install -config');
    expect(nsisHooks).toContain('sc delete YasserAgent');
    expect(nsisHooks).toContain('sc delete OdooPrintAgent');
    expect(windowsWorkflow).toContain('MSI did not install the YaseirAgent Windows service');
    expect(windowsWorkflow).toContain('MSI service did not preserve the legacy config path');
    expect(windowsWorkflow).toContain('NSIS service did not preserve the legacy config path');
  });

  it("keeps the Windows workflow read-only and immutable", () => {
    expect(windowsWorkflow).toMatch(/permissions:\s*\n\s+contents:\s+read/);
    expect(windowsWorkflow).not.toMatch(/permissions:\s*[\s\S]*contents:\s+write/);
    expect(windowsWorkflow).not.toContain("git push");
    expect(windowsWorkflow).not.toContain("git commit");
    expect(windowsWorkflow).toContain("cargo metadata --locked --no-deps");
  });
});
