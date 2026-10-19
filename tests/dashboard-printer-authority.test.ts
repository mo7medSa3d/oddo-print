// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/react";
import { hasManagerPermission } from "../src/lib/authorization";
import type { ManagerClaims, ManagerRole } from "../src/lib/manager-auth";
import { getDashboardJobsResult, getDashboardStateResult } from "../src/app/actions";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../src/app/actions", () => ({
  deleteAgentResult: vi.fn(), getDashboardJobsResult: vi.fn(), getDashboardStateResult: vi.fn(),
  setAgentLifecycleResult: vi.fn(), setPrinterLifecycleResult: vi.fn(),
}));

import type { Agent, Printer } from "../src/app/dashboard/dashboard-client";

const seen = new Date();
const agent = {
  id: "owner", name: "Reception", pairingCode: null, status: "online", lifecycle: "active",
  lastSeenAt: seen, createdAt: seen, printerCount: 1,
} as const satisfies Agent;
const printer = {
  id: "physical", agentId: agent.id, name: "Canon", printerType: "physical",
  connectionType: "spooler", protocol: "spooler", lifecycle: "active", status: "online", lastSeenAt: seen,
  sharedWithGateway: true,
} as const satisfies Printer;
const fleet = { pageSize: 100, agentOffset: 0, agentHasMore: false, printerOffset: 0,
  printerHasMore: false, totalAgents: 1, onlineAgents: 1, totalPrinters: 1, onlinePrinters: 1, savedPrinters: 0 };

async function renderTree(role: ManagerRole, lifecycle = "active", diagnosticActorScope = `test-workspace:${role}`, printerOverrides: Partial<Printer> = {}) {
  const { default: DashboardClient } = await import("../src/app/dashboard/dashboard-client");
  const claims: ManagerClaims = { sub: "manager", tenantId: "test-workspace", role, jti: "audit", iat: 1, exp: 2 };
  return h(I18nProvider, { initialLocale: "en", children: h(DashboardClient, {
    initialAgents: [{ ...agent, lifecycle }], initialPrinters: [{ ...printer, ...printerOverrides }], initialJobs: [], databaseError: null,
    initialFleet: fleet,
    canReadBillingUsage: hasManagerPermission(claims, "billing.read"),
    canMutate: { printers: hasManagerPermission(claims, "printers.manage"), printersTest: hasManagerPermission(claims, "printers.test"),
      agentsPair: hasManagerPermission(claims, "agents.pair"), agentsLifecycle: hasManagerPermission(claims, "agents.disable") || hasManagerPermission(claims, "agents.retire"),
      jobsCancel: hasManagerPermission(claims, "jobs.cancel"), jobsRetry: hasManagerPermission(claims, "jobs.retry") },
    diagnosticActorScope,
  }) });
}
const render = async (role: ManagerRole, lifecycle = "active") => renderToStaticMarkup(await renderTree(role, lifecycle));

describe("dashboard printer action authority", () => {
  it("retains a by-ID local-only printer with its raw health while blocking cloud diagnostic controls", async () => {
    const html = renderToStaticMarkup(await renderTree("operator", "active", "test-workspace:operator", { sharedWithGateway: false }));
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.body.textContent).toContain("Canon");
    expect(doc.body.textContent).toContain("Gateway sharing is turned off");
    const send = [...doc.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Send test page");
    expect(send).toBeDefined();
    expect(send!.disabled).toBe(true);
    expect(printer.status).toBe("online");
  });
  it("keeps read-only printer details while hiding both test-print controls", async () => {
    const html = await render("viewer");
    expect(html).toContain("Canon");
    expect(html).toContain("Technical details");
    expect(html).not.toContain(">Send test page<");
    expect(html).not.toContain(">Test page<");
  });

  it("retains the initial card test-print control for permitted operators", async () => {
    const html = await render("operator");
    expect(html).toContain(">Send test page<");
  });

  it.each([["viewer", false], ["operator", true]] as const)("enforces %s authority after switching to the real table view", async (role, allowed) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/api/auth/me") ? { exp: Math.floor(Date.now() / 1000) + 3600 } : {
        plan: { id: "audit-plan", name: "Audit" }, resources: { agents: { used: 1, limit: 3 }, printers: { used: 1, limit: 3 },
          prints: { unit: "job", used: 0, limit: 100, remaining: 100, periodStart: seen.toISOString(), periodEnd: null } },
      }
    ), { status: 200 })));
    vi.mocked(getDashboardJobsResult).mockResolvedValue({ ok: true, data: [] });
    vi.mocked(getDashboardStateResult).mockResolvedValue({ ok: true, data: {
      agents: [{ ...agent, pairingCodeExpiresAt: null, metadata: null, currentPrinterCount: 1, reportedStatus: agent.status, staleThresholdSeconds: 90 }],
      printers: [{ ...printer, agentName: agent.name, agentStatus: agent.status, agentLifecycle: agent.lifecycle, agentLastSeenAt: seen,
        agentStaleThresholdSeconds: 90, inventoryPresent: true, deviceClass: "unknown", config: null, capabilities: null }], jobs: [], fleet,
    } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      const tree = await renderTree(role);
      await act(async () => { root.render(tree); });
      const list = host.querySelector<HTMLButtonElement>('button[aria-label="List"]');
      expect(list).not.toBeNull();
      await act(async () => { list!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(list!.getAttribute("aria-pressed")).toBe("true");
      const table = host.querySelector("table.data-table");
      expect(table).not.toBeNull();
      expect(table!.textContent).toContain("Canon");
      expect([...table!.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Test page")).toBe(allowed);
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it.each(["viewer", "operator", "integration_admin"] as const)("hides Agent registration and re-enable from %s", async (role) => {
    const html = await render(role, "disabled");
    expect(html).toContain("Reception");
    expect(html).not.toContain("Register an agent");
    expect(html).not.toContain("Re-enable agent…");
    expect(html).not.toContain("Actions for agent Reception");
  });

  it.each(["owner", "admin"] as const)("retains Agent registration and re-enable for %s", async (role) => {
    const html = await render(role, "disabled");
    expect(html).toContain("Register an agent");
    expect(html).toContain("Re-enable agent…");
    expect(html).toContain("Actions for agent Reception");
  });

  it("uses matching lifecycle authority for every currently defined role and guards deletion", () => {
    for (const role of ["owner", "admin", "operator", "viewer", "integration_admin", "billing_admin"] as const) {
      const claims: ManagerClaims = { sub: "manager", tenantId: "test-workspace", role, jti: "audit", iat: 1, exp: 2 };
      expect(hasManagerPermission(claims, "agents.disable")).toBe(hasManagerPermission(claims, "agents.retire"));
    }
    const page = readFileSync("src/app/dashboard/page.tsx", "utf8");
    const client = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
    expect(page).toContain('agentsPair: hasManagerPermission(claims, "agents.pair")');
    expect(client).toMatch(/canMutate\.agentsLifecycle \? \[\{\s*key: "delete"/);
  });

  it("guards every test/certification entry point with the server-projected permission", () => {
    const source = ts.createSourceFile("dashboard-client.tsx", readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const entryPoints: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "Button" &&
          node.openingElement.attributes.properties.some((attribute) => {
            if (!ts.isJsxAttribute(attribute) || attribute.name.getText(source) !== "onClick") return false;
            let opensMutation = false;
            const calls = (child: ts.Node) => {
              if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) &&
                  (child.expression.text === "handleGatewayTestPrint" || (child.expression.text === "setCertifyPrinter" && child.arguments[0]?.kind !== ts.SyntaxKind.NullKeyword))) opensMutation = true;
              ts.forEachChild(child, calls);
            };
            ts.forEachChild(attribute, calls);
            return opensMutation;
          })) {
        entryPoints.push(node);
      }
      if (ts.isObjectLiteralExpression(node) && node.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "key" && property.initializer.getText(source) === '"certify"')) {
        entryPoints.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(entryPoints).toHaveLength(5);
    for (const entry of entryPoints) {
      let ancestor: ts.Node | undefined = entry.parent;
      while (ancestor && !ts.isBinaryExpression(ancestor) && !ts.isConditionalExpression(ancestor)) ancestor = ancestor.parent;
      expect(ancestor && (ts.isBinaryExpression(ancestor) ? ancestor.left : (ancestor as ts.ConditionalExpression).condition).getText(source)).toBe("canMutate.printersTest");
    }
  });
});

const billingUsage = {
  plan: { id: "audit-plan", name: "Audit subscription" },
  resources: { agents: { used: 1, limit: 3 }, printers: { used: 1, limit: 3 },
    prints: { unit: "job", used: 7, limit: 100, remaining: 93, periodStart: seen.toISOString(), periodEnd: null } },
};
const usageResponse = () => new Response(JSON.stringify(billingUsage), { status: 200 });
const usageWarning = "Print usage is temporarily unavailable";

async function withMountedDashboard(
  role: ManagerRole,
  fetchUsage: (init: RequestInit | undefined) => Promise<Response>,
  inspect: (host: HTMLDivElement, fetchMock: ReturnType<typeof vi.fn>, rerender: (role: ManagerRole, scope?: string) => Promise<void>) => Promise<void>,
  hasSubscription = true,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/billing/status") {
      return Response.json({ hasSubscription }, { status: 200 });
    }
    if (String(input) === "/api/billing/usage") return fetchUsage(init);
    if (String(input) === "/api/auth/me") return new Response(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
    throw new Error(`Unexpected dashboard fetch: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(getDashboardJobsResult).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(getDashboardStateResult).mockResolvedValue({ ok: true, data: {
    agents: [{ ...agent, pairingCodeExpiresAt: null, metadata: null, currentPrinterCount: 1, reportedStatus: agent.status, staleThresholdSeconds: 90 }],
    printers: [{ ...printer, agentName: agent.name, agentStatus: agent.status, agentLifecycle: agent.lifecycle, agentLastSeenAt: seen,
      agentStaleThresholdSeconds: 90, inventoryPresent: true, deviceClass: "unknown", config: null, capabilities: null }], jobs: [], fleet,
  } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const rerender = async (nextRole: ManagerRole, scope = `test-workspace:${nextRole}`) => {
    const tree = await renderTree(nextRole, "active", scope);
    await act(async () => { root.render(tree); });
  };
  try {
    await rerender(role);
    await inspect(host, fetchMock, rerender);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
  }
}

const usageRequests = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([input]) => input === "/api/billing/usage");
async function refreshDashboard(host: HTMLDivElement) {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh console data"]');
  expect(button).not.toBeNull();
  await act(async () => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

describe("dashboard billing read authority", () => {
  it.each(["viewer", "operator", "integration_admin"] as const)("does not poll forbidden billing or show an outage for %s", async (role) => {
    await withMountedDashboard(role, async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }), async (host, fetchMock) => {
      expect(host.textContent).toContain("Canon");
      await refreshDashboard(host);
      expect(usageRequests(fetchMock)).toHaveLength(0);
      expect(host.textContent).not.toContain(usageWarning);
      expect(host.textContent).not.toContain("Print credits");
    });
  });

  it.each(["owner", "admin"] as const)("does not report a billing outage or call usage during onboarding for %s", async (role) => {
    await withMountedDashboard(role, async () => { throw new Error("Quota request must not happen"); }, async (host, fetchMock) => {
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/billing/status")).toHaveLength(1);
      expect(usageRequests(fetchMock)).toHaveLength(0);
      expect(host.textContent).not.toContain(usageWarning);
      expect(host.textContent).not.toContain("Print credits");
      await refreshDashboard(host);
      expect(usageRequests(fetchMock)).toHaveLength(0);
    }, false);
  });

  it.each(["owner", "admin"] as const)("retains fetched print usage for %s", async (role) => {
    await withMountedDashboard(role, async () => usageResponse(), async (host, fetchMock) => {
      expect(usageRequests(fetchMock).length).toBeGreaterThan(0);
      expect(host.textContent).toContain("Audit subscription");
      expect(host.textContent).toContain("Print credits");
      expect(host.textContent).not.toContain(usageWarning);
    });
  });

  it.each([403, 503])("preserves a permitted actor's %s failure and real Retry recovery", async (status) => {
    const fetchUsage = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unavailable" }), { status }))
      .mockImplementation(async () => usageResponse());
    await withMountedDashboard("admin", fetchUsage, async (host, fetchMock) => {
      expect(host.textContent).toContain(usageWarning);
      const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry");
      expect(retry).toBeDefined();
      const before = usageRequests(fetchMock).length;
      await act(async () => { retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(usageRequests(fetchMock)).toHaveLength(before + 1);
      expect(host.textContent).toContain("Audit subscription");
      expect(host.textContent).not.toContain(usageWarning);
    });
  });

  it.each(["usage", "error"] as const)("clears prior billing %s when read authority is revoked", async (mode) => {
    await withMountedDashboard("admin", async () => mode === "usage" ? usageResponse() : new Response("unavailable", { status: 503 }), async (host, fetchMock, rerender) => {
      expect(host.textContent).toContain(mode === "usage" ? "Audit subscription" : usageWarning);
      const before = usageRequests(fetchMock).length;
      await rerender("viewer");
      await refreshDashboard(host);
      expect(usageRequests(fetchMock)).toHaveLength(before);
      expect(host.textContent).not.toContain("Audit subscription");
      expect(host.textContent).not.toContain(usageWarning);
      expect(host.textContent).not.toContain("Print credits");
    });
  });

  it("aborts and ignores an old actor's response after permission loss and restoration", async () => {
    let resolveOld!: (response: Response) => void;
    let oldSignal: AbortSignal | null | undefined;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetchUsage = vi.fn().mockImplementationOnce((init?: RequestInit) => {
      oldSignal = init?.signal;
      return oldResponse;
    }).mockImplementation(async () => new Response(JSON.stringify({ ...billingUsage, plan: { id: "new", name: "Current subscription" } }), { status: 200 }));
    await withMountedDashboard("admin", fetchUsage, async (host, fetchMock, rerender) => {
      expect(usageRequests(fetchMock)).toHaveLength(1);
      await rerender("viewer");
      expect(oldSignal?.aborted).toBe(true);
      await rerender("admin");
      expect(host.textContent).toContain("Current subscription");
      await act(async () => { resolveOld(usageResponse()); });
      expect(host.textContent).toContain("Current subscription");
      expect(host.textContent).not.toContain("Audit subscription");
      expect(host.textContent).not.toContain(usageWarning);
    });
  });

  it("clears another actor's usage immediately while the current actor's fetch is pending", async () => {
    let resolveCurrent!: (response: Response) => void;
    const currentResponse = new Promise<Response>((resolve) => { resolveCurrent = resolve; });
    const fetchUsage = vi.fn().mockImplementationOnce(async () => usageResponse()).mockImplementation(() => currentResponse);
    await withMountedDashboard("admin", fetchUsage, async (host, _fetchMock, rerender) => {
      expect(host.textContent).toContain("Audit subscription");
      await rerender("admin", "other-workspace:other-user:admin");
      expect(host.textContent).not.toContain("Audit subscription");
      expect(host.textContent).not.toContain("Print credits");
      await act(async () => { resolveCurrent(new Response(JSON.stringify({ ...billingUsage, plan: { id: "new", name: "Current subscription" } }), { status: 200 })); });
      expect(host.textContent).toContain("Current subscription");
    });
  });

  it("projects the exact backend billing.read permission at the only production renderer", () => {
    const page = readFileSync("src/app/dashboard/page.tsx", "utf8");
    expect(page).toContain('canReadBillingUsage={hasManagerPermission(claims, "billing.read")}');
    const route = readFileSync("src/app/api/billing/usage/route.ts", "utf8");
    expect(route).toContain('requireManagerPermission(manager, "billing.read")');
  });
});
