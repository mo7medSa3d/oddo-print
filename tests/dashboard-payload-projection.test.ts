import { readFileSync } from "node:fs";
import { gatewayTestSigningKey } from "./helpers/test-secrets";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  closePool,
  seedFixture,
  insertQueuedJob,
} from "./helpers/pg";
import { createManagerSession } from "../src/lib/manager-auth";
import type { Fixture } from "./helpers/pg";

let currentManagerToken: string | null = null;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (_name: string) => (currentManagerToken ? { value: currentManagerToken } : undefined),
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Import actions after mocks (same ordering as agent-deletion.test.ts)
import { getDashboardState, getDashboardJobs } from "../src/app/actions";

const suite = describe.skipIf(!hasTestDatabase);

describe("dashboard diagnostic payload loading contract", () => {
  it("shows loading only while the details request is actually in flight", () => {
    const source = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
    expect(source).toContain('if (payload === undefined) return t("job.noPayload")');
    expect(source).not.toContain('if (payload === undefined) return t("loading.payload")');
    expect(source).toContain('selectedJobPayloadLoading');
    expect(source).toContain('? t("loading.payload")');
    expect(source).toContain('setSelectedJobPayloadLoading(true)');
    expect(source).toContain('setSelectedJobPayloadLoading(false)');
    expect(source).toContain('retrySelectedJobPayload');
    expect(source).toContain('setSelectedJobPayloadReloadKey((key) => key + 1)');
    expect(source).toContain('{t("common.retry")}');
    expect(source).toContain("?includePayload=1");
  });
});

// Audit P1-02 regression: the dashboard 50-row list (page.tsx initial props
// AND the getDashboardState poll payload) must be metadata-only. Full
// payloads (base64 documents, multi-MB per job) remain server-side. The
// inspector fetches one job explicitly with includePayload=1; list/poll queries remain metadata-only.
suite("dashboard list queries never carry full job payloads", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey();
    process.env.MANAGER_USERNAME = "manager";
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    const session = await createManagerSession(fixture.tenantId);
    currentManagerToken = session.token;
  });

  it("getDashboardState returns jobs without the payload column", async () => {
    await insertQueuedJob(fixture, "job_payload_probe_1");
    const state = await getDashboardState();
    expect(state.jobs.length).toBeGreaterThan(0);
    for (const job of state.jobs) {
      expect(job).not.toHaveProperty("payload");
      expect(job.id).toBe("job_payload_probe_1");
    }
  });

  it("getDashboardJobs returns jobs without the payload column", async () => {
    await insertQueuedJob(fixture, "job_payload_probe_2");
    const rows = await getDashboardJobs({ limit: 50 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("payload");
    }
  });
});
