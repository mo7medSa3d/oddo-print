import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(path, "utf8");
}

describe("Gateway Odoo E2E test activity UI and data boundaries", () => {
  it("adds a discoverable integration navigation route with explicit receipt stages", () => {
    const shell = source("src/components/AppShell.tsx");
    const page = source("src/app/capture-tests/page.tsx");
    const dashboard = source("src/app/dashboard/page.tsx");
    const client = source("src/app/capture-tests/capture-tests-client.tsx");
    expect(shell).toContain('href: "/capture-tests"');
    expect(dashboard).toContain('href="/capture-tests"');
    expect(page).toContain('hasManagerPermission(claims, "jobs.read")');
    expect(client).toContain("captureMonitor.gatewayReceived");
    expect(client).toContain("captureMonitor.agentReceived");
    expect(client).toContain("run.agentReceived");
    expect(client).toContain("captureMonitor.rendered");
    expect(client).toContain("captureMonitor.simulation");
    expect(client).toContain('from "@radix-ui/react-dialog"');
    expect(client).toContain("Dialog.Description");
    expect(client).toContain("max-h-[54vh]");
  });

  it("keeps metadata-only listing, tenant fences and limited user-confirmed cleanup", () => {
    const route = source("src/app/api/test-captures/route.ts");
    const preview = source("src/app/api/test-captures/preview/route.ts");
    expect(route).toContain("validateWorkspaceManager(req)");
    expect(route).toContain('requireManagerPermission(claims, "jobs.read")');
    expect(route).toContain('requireManagerPermission(claims, "jobs.cancel")');
    expect(route).toContain("requireManagerActorInTransaction");
    expect(route).toContain("requireActiveTenantInTransaction");
    expect(route).toContain("rowFilter");
    expect(route).toContain('z.literal(true)');
    expect(route).toContain("const MAX_DELETE = 200");
    expect(route).not.toContain("DELETE FROM print_jobs");
    expect(route).not.toContain("payloadJson: e2eCaptureRuns.payloadJson");
    expect(route).not.toContain("previewJpeg: e2eCaptureRuns.previewJpeg");
    expect(preview).toContain('requireManagerPermission(claims, "jobs.payload.read")');
    expect(preview).toContain("eq(e2eCaptureRuns.tenantId, claims.tenantId)");
    expect(preview).toContain("CAPTURE_MAX_PREVIEW_BYTES");
    expect(preview).not.toContain("readFile(");
  });

  it("provides both Arabic and English translations for the console and statuses", () => {
    const en = source("src/i18n/messages/en.ts");
    const ar = source("src/i18n/messages/ar.ts");
    for (const text of [en, ar]) {
      for (const key of ["nav.captureTests", "captureMonitor.title", "captureMonitor.gatewayReceived",
        "captureMonitor.agentReceived", "captureMonitor.confirmTitle",
        "captureMonitor.noTestsTitle", "captureMonitor.preview", "captureMonitor.featureDisabledBody"]) {
        expect(text).toContain('"' + key + '":');
      }
    }
  });
});
