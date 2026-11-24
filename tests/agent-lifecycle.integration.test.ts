import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { transitionTenantLifecycle, TenantLifecycleError } from "../src/lib/tenant-lifecycle";
import { verifyLicenseBundle } from "../src/lib/license-signer";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("License-Only Gateway lifecycle & Direct Odoo <-> Agent contract", () => {
  it("removes legacy cloud agent-lifecycle module and Gateway agent fleet routes", () => {
    expect(existsSync(join(root, "src/lib/agent-lifecycle.ts"))).toBe(false);
    expect(existsSync(join(root, "src/app/api/agents/route.ts"))).toBe(false);
    expect(existsSync(join(root, "src/app/api/agents/[id]/route.ts"))).toBe(false);
  });

  it("keeps tenant lifecycle authority and signed license control-plane modules intact", () => {
    expect(typeof transitionTenantLifecycle).toBe("function");
    expect(typeof TenantLifecycleError).toBe("function");
    expect(typeof verifyLicenseBundle).toBe("function");

    const refreshRoute = read("src/app/api/license/refresh/route.ts");
    const verifyRoute = read("src/app/api/license/verify/route.ts");
    expect(refreshRoute).toContain('tenant.lifecycle !== "active"');
    expect(refreshRoute).toContain("buildRevocationTombstone");
    expect(verifyRoute).toContain('tenant.lifecycle !== "active"');
    expect(verifyRoute).toContain("workspace_not_active");
  });

  it("treats Gateway agent fleet fetches in desktop IPC as License-Only no-ops", () => {
    const ipc = read("src/desktop/lib/ipc.ts");
    expect(ipc).toContain("Gateway is a License-Only control plane; agent fleet routes were removed.");
    expect(ipc).toContain("export async function fetchGatewayAgents");
  });
});
