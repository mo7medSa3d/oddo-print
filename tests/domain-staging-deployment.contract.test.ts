import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("domain staging deployment contracts", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("pins the test domain and keeps Gateway port 3000 private", () => {
    const compose = read("docker-compose.yml");
    const domainCompose = read("deploy/domain-test/docker-compose.yml");
    const caddy = read("deploy/domain-test/Caddyfile");

    expect(compose).toContain("${APP_BASE_URL:-https://print.yaseir.cloud}");
    expect(compose).toContain("${GATEWAY_DOMAIN:-print.yaseir.cloud}");
    expect(compose).toContain('COOKIE_SECURE: ${COOKIE_SECURE:-1}');
    expect(compose).toContain('TRUST_PROXY: ${TRUST_PROXY:-1}');
    expect(compose).toContain('expose:');
    expect(compose).not.toMatch(/gateway:[\s\S]*?ports:/);

    expect(domainCompose).toContain("- postgres_http_test_data:/var/lib/postgresql/data");
    expect(domainCompose).toContain('"80:80"');
    expect(domainCompose).toContain('"443:443"');
    expect(domainCompose).not.toMatch(/gateway:[\s\S]*?ports:/);

    expect(caddy).toContain("{$GATEWAY_DOMAIN}");
    expect(caddy).toContain("reverse_proxy gateway:3000");
    expect(caddy).toContain("X-Gateway-Proxy-Token");
  });

  it("keeps the existing HTTP CI harness separate", () => {
    const workflow = read(".github/workflows/http-staging-transport.yml");
    const httpCaddy = read("deploy/http-test/Caddyfile");
    expect(workflow).toContain("HTTP Gateway + Agent transport E2E");
    expect(httpCaddy).toContain("http://");
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
});
