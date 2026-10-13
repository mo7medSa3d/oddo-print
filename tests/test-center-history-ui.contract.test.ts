import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("Agent Test Center remote history privacy and accessibility", () => {
  it("keeps a scoped read-only inbox plus a separate terminal-only DELETE", () => {
    const api = source("src/app/api/agent/test-captures/status/route.ts");
    const rust = source("src-tauri/src/commands.rs");
    const go = source("agent/cmd/cli/gateway.go");
    expect(api).toContain("export async function DELETE(req: Request)");
    expect(api).toContain('req.headers.get("authorization")');
    expect(api).toContain("tenant_id = ${agent.tenantId} AND agent_id = ${agent.id}");
    expect(api).toContain("status IN ('rendered_locally', 'failed', 'expired')");
    expect(api).toContain("expires_at <= now()");
    expect(api).not.toContain("DELETE FROM print_jobs");
    expect(rust).toContain('"DELETE" => path == "/api/agent/test-captures/status"');
    expect(go).toContain('case "DELETE":');
    expect(go).toContain('return path == "/api/agent/test-captures/status"');
  });

  it("requires protected local data roots, allows only capture output names, and preserves fresh data", () => {
    const local = source("src-tauri/src/commands.rs");
    const agent = source("agent/cmd/cli/capture_cleanup.go");
    expect(local).toContain("if !is_running_as_admin()");
    expect(local).toContain("ensure_manager_directory_security");
    expect(local).toContain('strip_prefix("capture-")');
    expect(local).toContain("CAPTURE_CLEANUP_GRACE_SECS");
    expect(agent).toContain("EnsureSecureDirectoryACL");
    expect(agent).toContain("filepath.EvalSymlinks");
    expect(agent).toContain("captureCleanupGracePeriod");
    expect(agent).toContain("info.Mode().IsRegular()");
  });

  it("renders readable, keyboard-dismissible previews instead of file:// PDF access", () => {
    const ui = source("src/desktop/components/CaptureHistory.tsx");
    const page = source("src/desktop/pages/TestCenter.tsx");
    expect(ui).toContain('from "@radix-ui/react-dialog"');
    expect(ui).toContain("Dialog.Root");
    expect(ui).toContain("Dialog.Description");
    expect(ui).toContain("Dialog.Close");
    expect(ui).toContain("previewFirstPage");
    expect(ui).toContain("previewZoomIn");
    expect(ui).toContain("previewFit");
    expect(page).toContain("CapturePreviewDialog");
    expect(page).toContain("ClearCapturesDialog");
    expect(page).toContain("clearLocalTestCaptures");
    expect(page).toContain("clearGatewayTestHistory");
    expect(page).toContain("CAPTURE_ENDPOINT_UNAVAILABLE");
    expect(ui).not.toContain('src={run.pdfPath}');
  });
});
