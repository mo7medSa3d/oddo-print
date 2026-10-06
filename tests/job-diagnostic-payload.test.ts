import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildJobDiagnosticPayload } from "../src/lib/job-diagnostic-payload";

describe("job diagnostic payload", () => {
  it("returns useful transport evidence without exposing print bytes", () => {
    const bytes = Buffer.from("secret invoice contents", "utf8");
    const raw = bytes.toString("base64");
    const diagnostic = buildJobDiagnosticPayload({
      type: "pdf",
      encoding: "base64",
      peripherals: { drawer: "none", cutter: "customer secret", ignored: "secret" },
      data: raw,
      customerName: "must not leak",
    });

    expect(diagnostic).toMatchObject({
      type: "pdf",
      encoding: "base64",
      protocol: null,
      peripherals: { drawer: "none" },
      data: {
        redacted: true,
        base64Characters: raw.length,
        decodedBytes: bytes.length,
      },
    });
    expect(diagnostic?.data?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(diagnostic)).not.toContain(raw);
    expect(JSON.stringify(diagnostic)).not.toContain("secret invoice contents");
    expect(JSON.stringify(diagnostic)).not.toContain("customerName");
    expect(JSON.stringify(diagnostic)).not.toContain("customer secret");
  });

  it("keeps corrupt legacy base64 diagnosable without inventing a digest", () => {
    const diagnostic = buildJobDiagnosticPayload({ type: "raw", encoding: "base64", data: "!!!" });
    expect(diagnostic?.data).toEqual({ redacted: true, base64Characters: 3, decodedBytes: null, sha256: null });
  });

  it("keeps default job diagnostics redacted but lets the explicit inspector request the tenant-scoped payload", () => {
    const route = readFileSync("src/app/api/jobs/[id]/route.ts", "utf8");
    const dashboard = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");

    expect(route).toContain("eq(printJobs.tenantId, claims.tenantId)");
    expect(route).toContain('searchParams.get("includePayload") === "1"');
    expect(route).toContain("includePayload");
    expect(route).toContain("buildJobDiagnosticPayload(payload)");
    expect(route).toContain('"Cache-Control": "private, no-store"');
    expect(route).toContain("const { payload, ...metadata } = row[0]");

    expect(dashboard).toContain("?includePayload=1");
    expect(dashboard).toContain("new AbortController()");
    expect(dashboard).toContain("8_000");
    expect(dashboard).toContain('t("job.payloadLoadFailed")');
    expect(dashboard).toContain("value: row.diagnosticPayload ?? null");
  });

  it("returns null for non-object legacy payloads", () => {
    expect(buildJobDiagnosticPayload(null)).toBeNull();
    expect(buildJobDiagnosticPayload("raw")).toBeNull();
  });
});
