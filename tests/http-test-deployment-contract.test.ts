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

  it("models the real Tauri origin for the desktop bearer-login smoke step", () => {
    const smoke = read("deploy/http-test/smoke-http-test.sh");
    expect(smoke).toContain("Origin: tauri://localhost");
    expect(smoke).toContain("X-Odoo-Print-Desktop: 1");
    expect(smoke).toContain('"${DESKTOP_HEADERS[@]}"');
  });
  it("passes the HTTP test login username into tenant resolution", () => {
    const route = read("src/app/api/auth/manager/login/route.ts");
    expect(route).toContain("resolveManagerTenantId(req, username)");
  });
});
