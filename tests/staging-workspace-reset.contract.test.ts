import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const load = (path: string) => readFileSync(path, "utf8");
const compose = load("deploy/domain-test/docker-compose.yml");
const setup = load("deploy/domain-test/setup-domain-test.sh");
const example = load("deploy/domain-test/.env.domain-test.example");
const reset = load("deploy/domain-test/reset-staging-workspace.sh");
const legacy = load("deploy/http-test/smoke-http-test.sh");
const readme = load("deploy/domain-test/README.md");

describe("single workspace staging reset safeguards", () => {
  it("parses the reset and disabled legacy scripts as valid Bash", () => {
    for (const file of [
      "deploy/domain-test/reset-staging-workspace.sh",
      "deploy/http-test/smoke-http-test.sh",
    ]) {
      const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
      expect(result.status, result.stderr || "bash not available").toBe(0);
    }
  });

  it("enforces one-workspace mode on the HTTPS staging stack only", () => {
    expect(compose).toContain('YASEIR_STAGING_SINGLE_WORKSPACE: "1"');
    expect(setup).toContain("upsert_env YASEIR_STAGING_SINGLE_WORKSPACE 1");
    expect(example).toContain("YASEIR_STAGING_SINGLE_WORKSPACE=1");
    expect(load("docker-compose.yml")).not.toContain("YASEIR_STAGING_SINGLE_WORKSPACE");
  });
  it("disables the old data-creating HTTP smoke by default", () => {
    expect(legacy).toContain("ALLOW_LEGACY_DATA_CREATING_SMOKE:-0");
    expect(legacy).toContain("deploy/domain-test/smoke-domain-test.sh");
    expect(legacy).toContain("http://127.0.0.1:*");
  });
  it("requires explicit interactive consent and a fully verified backup first", () => {
    expect(reset).toContain('[[ -t 0 ]]');
    expect(reset).toContain('"RESET HTTPS STAGING"');
    expect(reset).toContain('DB_NAME" != "yasser_http_test"');
    expect(reset).toContain('DOMAIN" != "print.yaseir.cloud"');
    expect(reset).toContain("pg_dump -Fc");
    expect(reset).toContain("pg_restore --list");
    expect(reset).toContain("sha256sum");
    expect(reset).toContain('BACKUP_DIR="$HOME/.local/share/yaseir-staging-backups"');
    expect(reset).not.toContain('BACKUP_DIR="$ROOT/backups/domain-staging"');
    expect(reset.indexOf("pg_restore --list")).toBeLessThan(reset.indexOf("compose down --remove-orphans"));
  });
  it("preserves original data and uses new volume and credentials", () => {
    expect(reset).toContain('docker volume create');
    expect(reset).toContain('replace_env HTTP_TEST_VOLUME_NAME "$NEW_VOLUME"');
    expect(reset).toContain('replace_env MANAGER_TENANT_ID ""');
    expect(reset).toContain('replace_env GATEWAY_JWT_SECRET');
    expect(reset).toContain('replace_env POSTGRES_PASSWORD');
    expect(reset).not.toMatch(/docker volume rm|down -v|DELETE FROM tenants|TRUNCATE tenants/i);
    expect(reset).toContain('NEW_COUNT" == "0"');
  });
  it("documents how to register a single new owner and restore Agent/Odoo access", () => {
    for (const word of ["--dry-run", "--apply", "30-day trial", "re-pair Windows Agents", "original volume"]) {
      expect(readme.toLowerCase()).toContain(word.toLowerCase());
    }
    expect(setup).not.toContain("reset-staging-workspace.sh");
  });
});
