import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("billing portal idempotency contract", () => {
  it("uses a unique idempotency key per request to avoid replaying an expired portal URL", () => {
    const src = read("src/app/api/billing/portal/route.ts");
    // Must import randomUUID for unique key generation
    expect(src).toContain("randomUUID");
    // Must NOT use a static tenant-only key that would cause Stripe to replay same URL for 24h
    // The old buggy pattern was exactly `portal-` + tenantId
    expect(src).not.toMatch(/\"portal-\"\s*\+\s*claims\.tenantId(?!.*randomUUID)/s);
    // New pattern includes tenantId + randomUUID
    expect(src).toMatch(/portal-\$\{claims\.tenantId\}-\$\{randomUUID\(\)\}|portal-.*randomUUID/);
    // Must still call stripeRequest with billing_portal/sessions path
    expect(src).toContain("billing_portal/sessions");
  });

  it("documents why static keys are unsafe for short-lived portal sessions", () => {
    const src = read("src/app/api/billing/portal/route.ts");
    expect(src).toContain("short-lived");
    expect(src).toContain("expired");
    expect(src).toContain("24h");
  });
});
