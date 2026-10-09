import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("domain staging deployment contracts", () => {
  const read = (path: string) =>
    readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n?/g, "\n");

  it("pins the test domain and keeps Gateway port 3000 private", () => {
    const compose = read("docker-compose.yml");
    const domainCompose = read("deploy/domain-test/docker-compose.yml");
    const caddy = read("deploy/domain-test/Caddyfile");
    expect(domainCompose).toContain("postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea");
    expect(domainCompose).toContain("caddy:2.11.4-alpine@sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e");

    expect(compose).toContain("APP_BASE_URL: ${APP_BASE_URL:?APP_BASE_URL must be set to the public Gateway URL}");
    expect(compose).not.toContain("YASEIR_HTTP_TEST_MODE");
    expect(compose).not.toContain("YASSER_HTTP_TEST_MODE");
    expect(compose).toContain("GATEWAY_DOMAIN: ${GATEWAY_DOMAIN:?GATEWAY_DOMAIN must be set to a DNS name for production TLS}");
    expect(compose).toContain('COOKIE_SECURE: ${COOKIE_SECURE:-1}');
    expect(compose).toContain('TRUST_PROXY: ${TRUST_PROXY:-1}');
    expect(compose).toContain("expose:");
    const gatewayBlock = compose.split("\n  caddy:\n")[0].split("\n  gateway:\n")[1];
    expect(gatewayBlock).toBeTruthy();
    expect(gatewayBlock).not.toContain("ports:");

    expect(domainCompose).toContain("- postgres_http_test_data:/var/lib/postgresql/data");
    expect(domainCompose).toContain("name: ${HTTP_TEST_VOLUME_NAME:?HTTP_TEST_VOLUME_NAME must be set}");
    expect(domainCompose).toContain('YASEIR_HTTP_TEST_MODE: "1"');
    expect(domainCompose).toContain('"80:80"');
    expect(domainCompose).toContain('"443:443"');
    const domainGatewayBlock = domainCompose.split("\n  caddy:\n")[0].split("\n  gateway:\n")[1];
    expect(domainGatewayBlock).toBeTruthy();
    expect(domainGatewayBlock).not.toContain("ports:");

    expect(caddy).toContain("{$GATEWAY_DOMAIN}");
    expect(caddy).toContain("reverse_proxy gateway:3000");
    expect(caddy).toContain("X-Gateway-Proxy-Token");
  });

  it("checks HTTPS policy in staging CI", () => {
    const workflow = read(".github/workflows/http-staging-transport.yml");
    expect(workflow).toContain("HTTPS Gateway + Agent security contracts");
    expect(workflow).not.toContain("bash deploy/http-test/setup-http-test.sh");
  });

  it("enables secure cookies and trusted proxy handling for the domain deployment", () => {
    const env = read("deploy/domain-test/.env.domain-test.example");
    const compose = read("deploy/domain-test/docker-compose.yml");
    expect(env).toContain("APP_BASE_URL=https://print.yaseir.cloud");
    expect(env).toContain("COOKIE_SECURE=1");
    expect(env).toContain("TRUST_PROXY=1");
    expect(compose).toContain('COOKIE_SECURE: "1"');
    expect(compose).toContain('TRUST_PROXY: "1"');
  });
  it("configures the workspace domain after migrations and before Gateway startup", () => {
    const setup = read("deploy/domain-test/setup-domain-test.sh");
    const sql = read("deploy/domain-test/configure-domain.sql");
    expect(setup.indexOf("run --rm --build migrate")).toBeLessThan(setup.indexOf(' < "$DEPLOY_DIR/configure-domain.sql"'));
    expect(setup.indexOf(' < "$DEPLOY_DIR/configure-domain.sql"')).toBeLessThan(setup.indexOf("up -d --build"));
    expect(setup).toContain("ON_ERROR_STOP=1");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("ON CONFLICT (domain) DO UPDATE");
    expect(sql).toContain("refusing to reassign it");
    expect(sql).toMatch(/candidate_count > 1 THEN\s+RAISE NOTICE '[^']+';\s+RETURN;/);
    expect(sql).not.toContain("RAISE EXCEPTION 'Multiple staging workspaces");
    expect(sql).toContain("lifecycle = 'active'");
    expect(sql).not.toMatch(/DELETE FROM|DROP TABLE|UPDATE users|UPDATE tenants/);
    expect(setup).not.toContain("curl -k");
  });
});
