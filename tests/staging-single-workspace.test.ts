import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import {
  assertStagingWorkspaceSlot,
  isSingleWorkspaceStaging,
  stagingWorkspaceExists,
  StagingWorkspaceExistsError,
} from "../src/lib/staging-single-workspace";

const original = {
  YASEIR_HTTP_TEST_MODE: process.env.YASEIR_HTTP_TEST_MODE,
  YASEIR_STAGING_SINGLE_WORKSPACE: process.env.YASEIR_STAGING_SINGLE_WORKSPACE,
  APP_BASE_URL: process.env.APP_BASE_URL,
};
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});
const enable = () => {
  process.env.YASEIR_HTTP_TEST_MODE = "1";
  process.env.YASEIR_STAGING_SINGLE_WORKSPACE = "1";
  process.env.APP_BASE_URL = "https://print.yaseir.cloud";
};
const dialect = new PgDialect();
const runner = (found = false) => {
  const queries: string[] = [];
  const execute = vi.fn(async (q) => {
    const compiled = dialect.sqlToQuery(q).sql;
    queries.push(compiled);
    return { rows: /FROM tenants/i.test(compiled) && found ? [{ id: "ten_existing" }] : [] };
  });
  return { execute, queries };
};

describe("staging single-workspace admission", () => {
  it("is impossible to enable on main/other hosts by only setting the toggle", () => {
    process.env.YASEIR_STAGING_SINGLE_WORKSPACE = "1";
    process.env.APP_BASE_URL = "https://gateway.example.com";
    delete process.env.YASEIR_HTTP_TEST_MODE;
    expect(isSingleWorkspaceStaging()).toBe(false);
    enable();
    expect(isSingleWorkspaceStaging()).toBe(true);
    process.env.APP_BASE_URL = "https://production.example.com";
    expect(isSingleWorkspaceStaging()).toBe(false);
  });
  it("does not touch the database when staging mode is disabled", async () => {
    const mock = runner(true);
    await assertStagingWorkspaceSlot(mock);
    expect(await stagingWorkspaceExists(mock)).toBe(false);
    expect(mock.execute).not.toHaveBeenCalled();
  });
  it("permits the first verified workspace with an advisory transaction lock", async () => {
    enable();
    const mock = runner(false);
    await expect(assertStagingWorkspaceSlot(mock)).resolves.toBeUndefined();
    expect(mock.queries[0]).toContain("pg_advisory_xact_lock");
    expect(mock.queries[1]).toContain("FROM tenants");
    expect(mock.queries[1]).toContain("lifecycle <> 'deleted'");
  });
  it("rejects every later workspace under the same transaction lock", async () => {
    enable();
    const mock = runner(true);
    await expect(assertStagingWorkspaceSlot(mock)).rejects.toBeInstanceOf(StagingWorkspaceExistsError);
    expect(mock.queries).toHaveLength(2);
  });
  it("does not create a second tenant through login or onboarding", () => {
    const login = readFileSync("src/app/api/auth/login/route.ts", "utf8");
    const onboarding = readFileSync("src/app/api/onboarding/route.ts", "utf8");
    const register = readFileSync("src/app/api/auth/register/route.ts", "utf8");
    const verification = readFileSync("src/app/api/auth/verify-email/route.ts", "utf8");
    expect(login).not.toContain("insert(tenants)");
    expect(onboarding).not.toContain("insert(tenants)");
    expect(register).toContain("if (isSingleWorkspaceStaging())");
    expect(register).toContain("stagingWorkspaceExists(db)");
    expect(verification).toContain("await assertStagingWorkspaceSlot(tx)");
    expect(verification).toContain("error instanceof StagingWorkspaceExistsError");
  });
});
