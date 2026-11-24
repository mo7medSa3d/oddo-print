import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../src/lib/customer-auth", () => ({ authenticateForTenant: auth.authenticate }));
vi.mock("../src/lib/auth-rate-limit", () => ({
  reserveAuthAttempt: async () => ({ allowed: true }), clientIpFrom: () => "192.0.2.10",
  recordAuthSuccess: async () => {}, setRateLimitHeaders: (response: Response) => response,
}));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: async () => {} }));
import { POST } from "../src/app/api/auth/login/route";

const request = () => new Request("https://gateway.test/api/auth/login", {
  method: "POST", body: JSON.stringify({ email: "owner@example.test", password: "synthetic-password" }),
});

describe("authenticated workspace choices", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns human workspace names with the existing ID contract and no cacheable credential", async () => {
    auth.authenticate.mockResolvedValue({
      multipleTenants: true, selectionToken: "synthetic-selection-token",
      memberships: [
        { tenantId: "tenant_cairo", name: "Cairo store", role: "owner" },
        { tenantId: "tenant_giza", name: "متجر الجيزة", role: "staff" },
      ],
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      workspaces: ["tenant_cairo", "tenant_giza"],
      workspaceOptions: [{ id: "tenant_cairo", name: "Cairo store" }, { id: "tenant_giza", name: "متجر الجيزة" }],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not disclose workspace choices without valid credentials", async () => {
    auth.authenticate.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid email or password" });
  });
});
