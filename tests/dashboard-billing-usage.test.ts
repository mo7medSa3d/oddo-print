import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchDashboardBillingUsage } from "../src/lib/dashboard-billing-usage";

type Fetcher = (path: string, init: RequestInit) => Promise<Response>;

function mockFetcher(
  subscription: { status: number; body: unknown },
  usage?: { status: number; body: unknown },
) {
  const calls: { path: string; init: RequestInit }[] = [];
  const get: Fetcher = async (path, init) => {
    calls.push({ path, init });
    if (path === "/api/billing/status") {
      return Response.json(subscription.body, { status: subscription.status });
    }
    if (path === "/api/billing/usage" && usage) {
      return Response.json(usage.body, { status: usage.status });
    }
    throw new Error("Unexpected billing request: " + path);
  };
  return { get, calls };
}

describe("dashboard billing preflight", () => {
  it("never probes protected usage for a workspace without an active subscription", async () => {
    const { get, calls } = mockFetcher({ status: 200, body: { hasSubscription: false } });
    const abort = new AbortController();
    const result = await fetchDashboardBillingUsage(get, abort.signal);
    expect(result).toEqual({ kind: "unsubscribed" });
    expect(calls.map((call) => call.path)).toEqual(["/api/billing/status"]);
    expect(calls[0].init).toMatchObject({ credentials: "same-origin", cache: "no-store", signal: abort.signal });
  });

  it("loads live usage when a valid subscription exists", async () => {
    const quota = { plan: { id: "p1", name: "Test" }, resources: { prints: { used: 2, limit: 10, remaining: 8 } } };
    const { get, calls } = mockFetcher({ status: 200, body: { hasSubscription: true } }, { status: 200, body: quota });
    const result = await fetchDashboardBillingUsage(get, new AbortController().signal);
    expect(result).toEqual({ kind: "available", usage: quota });
    expect(calls.map(({ path }) => path)).toEqual(["/api/billing/status", "/api/billing/usage"]);
  });

  it("does not request usage if the session is rejected or status is unavailable", async () => {
    for (const response of [
      { status: 401, body: { error: "Unauthorized" } },
      { status: 403, body: { error: "Forbidden" } },
      { status: 503, body: { error: "Unavailable" } },
      { status: 200, body: {} },
    ]) {
      const { get, calls } = mockFetcher(response);
      const result = await fetchDashboardBillingUsage(get, new AbortController().signal);
      expect(result.kind).toBe(response.status === 401 || response.status === 403 ? "forbidden" : "unavailable");
      expect(calls).toHaveLength(1);
    }
  });

  it("classifies a subsequent denied usage request without accepting stale quota data", async () => {
    for (const status of [401, 403]) {
      const { get, calls } = mockFetcher(
        { status: 200, body: { hasSubscription: true } },
        { status, body: { error: "Forbidden" } },
      );
      expect(await fetchDashboardBillingUsage(get, new AbortController().signal)).toEqual({ kind: "forbidden" });
      expect(calls).toHaveLength(2);
    }
  });

  it("rejects malformed quota responses and temporary backend errors", async () => {
    for (const usage of [
      { status: 200, body: {} },
      { status: 503, body: { error: "Temporarily unavailable" } },
    ]) {
      const { get } = mockFetcher({ status: 200, body: { hasSubscription: true } }, usage);
      expect(await fetchDashboardBillingUsage(get, new AbortController().signal)).toEqual({ kind: "unavailable" });
    }
  });

  it("does not couple billing polling to fleet refresh or auto-retry a forbidden actor", () => {
    const source = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
    const fleetRefresh = source.split("const refreshData = React.useCallback(")[1]?.split("\n  useEffect(() => {")[0];
    expect(fleetRefresh).toBeDefined();
    expect(fleetRefresh).not.toContain("refreshBillingUsage()");
    expect(source).toContain("}, 60_000)");
    expect(source).toContain("if (!canReadBillingUsage) return;");
    expect(source).toContain("billingForbiddenScopeRef.current === billingAuthority.diagnosticActorScope");
    expect(source).toContain("billingForbiddenScopeRef.current = billingAuthority.diagnosticActorScope");
    expect(source).toContain("if (retryForbidden) billingForbiddenScopeRef.current = null");
    expect(source).toContain("onClick={() => refreshBillingUsage(true)}");
  });

  it("keeps the server-side quota permission and subscription guard intact", () => {
    const endpoint = readFileSync("src/app/api/billing/usage/route.ts", "utf8");
    expect(endpoint).toContain('requireManagerPermission(manager, "billing.read")');
    expect(endpoint).toContain("if (!subscription) return NextResponse.json");
    expect(endpoint).toContain('status: 403');
  });
});
