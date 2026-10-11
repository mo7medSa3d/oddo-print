import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isServerActionVersionMismatch } from "../src/lib/server-action-version";
import { classifyJobFailure, jobFailurePresentation } from "../src/shared/job-vocabulary";

const source = (name: string) => readFileSync(name, "utf8");

describe("unattended Windows software writers and Next deployment skew", () => {
  it("offers accurate Arabic and English guidance for the two reported Windows errors", () => {
    const busy = 'ERR_PRINTER_NOT_READY: spooler session lock for "Microsoft Print to PDF" timed out after 15s';
    const oneNote = 'PDF print on "OneNote (Desktop)" failed: context deadline exceeded';
    expect(classifyJobFailure(busy)).toBe("spooler_session_busy");
    expect(classifyJobFailure(oneNote)).toBe("interactive_virtual_timeout");
    expect(jobFailurePresentation(busy, "en")?.guidance).toContain("Do not force-unlock");
    expect(jobFailurePresentation(busy, "ar")?.guidance).toContain("القفل");
    expect(jobFailurePresentation(oneNote, "en")?.guidance).toContain("Windows Agent service");
    expect(jobFailurePresentation(oneNote, "ar")?.guidance).toContain("الوكيل");
    expect(classifyJobFailure('PDF print on "HP LaserJet" failed: context deadline exceeded')).toBeNull();
    expect(classifyJobFailure("UNKNOWN_PARTIAL_DELIVERY: bytes may have been sent")).toBeNull();
  });

  it("detects only missing Server Action build IDs, with no unsafe retries", () => {
    expect(isServerActionVersionMismatch(new Error('Server Action "4002a8d604bc253c38e0c4612997b2660dbef2d3a3" was not found on the server. Read more: https://nextjs.org/docs/messages/failed-to-find-server-action'))).toBe(true);
    expect(isServerActionVersionMismatch(new Error('Failed to find Server Action "123"'))).toBe(true);
    expect(isServerActionVersionMismatch(new Error('SQL request failed'))).toBe(false);
    const ui = source("src/app/dashboard/dashboard-client.tsx");
    expect(ui).toContain('t("errors.pageUpdatedReload")');
    expect(ui).toContain('onClick={() => window.location.reload()}');
    expect(source("src/app/error.tsx")).toContain("isServerActionVersionMismatch(error)");
    // A failed action may have committed; automatically executing it again
    // after refresh would double-delete or double-print in a skew incident.
    expect(ui).not.toContain('isServerActionVersionMismatch(error) ? operation()');
  });

  it("wires release ID from Compose through Docker build and runtime", () => {
    expect(source("docker-compose.yml")).toContain("YASEIR_DEPLOYMENT_ID: ${YASEIR_DEPLOYMENT_ID:-}");
    expect(source("Dockerfile")).toContain("ARG YASEIR_DEPLOYMENT_ID");
    expect(source("next.config.ts")).toContain("deploymentId");
    expect(source("SERVER_FIRST_RUN.md")).toContain('YASEIR_DEPLOYMENT_ID="$RELEASE_ID"');
  });
});
