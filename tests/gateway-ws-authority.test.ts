import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { attachAgentWSS, getAgentWsCount } from "../src/server/ws";

const state = vi.hoisted(() => ({
  tenantLifecycle: "active",
  agentRevision: 0 as number | null,
  tenantWait: null as Promise<void> | null,
  tenantRead: false,
  queries: [] as string[],
  notify: null as ((notice: { channel: string; payload: string }) => void) | null,
  claim: vi.fn(),
}));

vi.mock("../src/db", () => ({ pool: {
  query: vi.fn(async (query: string) => {
    state.queries.push(query);
    return { rows: state.agentRevision === null ? [] : [{ lifecycle: "active", lifecycle_revision: state.agentRevision }] };
  }),
  connect: vi.fn(async () => ({
    on: (name: string, callback: typeof state.notify) => { if (name === "notification") state.notify = callback; },
    release: vi.fn(),
    query: async (query: string) => {
      state.queries.push(query);
      if (query.includes("FROM tenants")) {
        state.tenantRead = true;
        await state.tenantWait;
        return { rows: [{ lifecycle: state.tenantLifecycle }] };
      }
      if (query.includes("FROM agents")) return { rows: [{ lifecycle: "active", lifecycle_revision: state.agentRevision }] };
      return { rows: [] };
    },
  })),
} }));
vi.mock("../src/lib/agent-auth", () => ({ validateAgent: async () => ({ id: "ws-authority-agent", tenantId: "tenant-a", lifecycleRevision: 0 }) }));
vi.mock("../src/lib/ws-rate-limit", () => ({ reserveWsUpgradeAttempt: async () => ({ allowed: true }), recordWsUpgradeSuccess: async () => {} }));
vi.mock("../src/server/trusted-proxy", () => ({ trustProxyEnabled: () => false, isAllowedWebSocketOrigin: () => true, isTrustedProxyUpgrade: () => true }));
vi.mock("../src/lib/metrics", () => ({ incrementMetric: async () => {} }));
vi.mock("../src/lib/log", () => ({ logDebug() {}, logError() {}, logInfo() {}, logWarn() {} }));
vi.mock("../src/lib/job-delivery", () => ({
  claimJobForDelivery: state.claim,
  markJobDelivered: async () => true,
  markJobDeliveryUnknown: async () => true,
  recordJobAck: async () => true,
  releaseUndeliveredClaim: async () => "requeued",
}));

describe("Gateway WebSocket durable authority boundaries", () => {
  let server: Server;
  let socket: WebSocket;

  beforeEach(async () => {
    state.tenantLifecycle = "active";
    state.agentRevision = 0;
    state.tenantWait = null;
    state.tenantRead = false;
    state.queries = [];
    state.notify = null;
    state.claim.mockReset().mockResolvedValue({
      id: "job-a", tenantId: "tenant-a", agentId: "ws-authority-agent",
      printerId: "printer-a", status: "claimed", claimToken: "claim-a",
      expiresAt: new Date("2030-01-01T00:00:00Z"), payload: {}, retries: 0,
    });
    server = createServer();
    attachAgentWSS(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await vi.waitFor(() => expect(state.notify).not.toBeNull());
  });

  afterEach(async () => {
    socket?.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await vi.waitFor(() => expect(getAgentWsCount("ws-authority-agent")).toBe(0));
  });

  async function open(onSocket?: (client: WebSocket) => void) {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/agent/ws`, { headers: { Authorization: "Bearer fixture" } });
    onSocket?.(socket);
    await once(socket, "open");
  }

  function notify(channel: string, data: object) {
    state.notify!({ channel, payload: JSON.stringify(data) });
  }

  it("rejects suspension after authentication before socket registration", async () => {
    state.tenantLifecycle = "suspended";
    let closed!: Promise<unknown[]>;
    await open(client => { closed = once(client, "close"); });
    const [code] = await closed;
    expect(code).toBe(4001);
    expect(getAgentWsCount("ws-authority-agent")).toBe(0);
    expect(state.queries.some(query => query.includes("FROM agents"))).toBe(false);
  });

  it("holds the tenant fence before the tenant-scoped Agent fence", async () => {
    await open();
    await vi.waitFor(() => expect(getAgentWsCount("ws-authority-agent")).toBe(1));
    const tenant = state.queries.findIndex(query => query.includes("FROM tenants") && query.includes("FOR SHARE"));
    const agent = state.queries.findIndex(query => query.includes("FROM agents") && query.includes("tenant_id = $2"));
    expect(tenant).toBeGreaterThanOrEqual(0);
    expect(agent).toBeGreaterThan(tenant);
  });

  it("ignores a spoofed future lifecycle revision instead of closing a valid socket", async () => {
    await open();
    await vi.waitFor(() => expect(getAgentWsCount("ws-authority-agent")).toBe(1));
    notify("print_gateway_agent_sessions", { agentId: "ws-authority-agent", lifecycleRevision: 999 });
    await vi.waitFor(() => expect(state.queries.some(query => query.includes("WHERE id = $1") && !query.includes("FOR SHARE"))).toBe(true));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(getAgentWsCount("ws-authority-agent")).toBe(1);
  });

  it("closes a durably deleted Agent even when its legacy notice has no revision", async () => {
    await open();
    await vi.waitFor(() => expect(getAgentWsCount("ws-authority-agent")).toBe(1));
    state.agentRevision = null;
    const closed = once(socket, "close");
    notify("print_gateway_agent_sessions", { agentId: "ws-authority-agent" });
    expect((await closed)[0]).toBe(4001);
  });

  it.each(["tenant-a", "tenant-b"])("validates tenant %s after pending registration before claiming", async (tenantId) => {
    let release!: () => void;
    state.tenantWait = new Promise<void>(resolve => { release = resolve; });
    await open();
    await vi.waitFor(() => expect(state.tenantRead).toBe(true));
    const received = tenantId === "tenant-a" ? once(socket, "message") : null;
    notify("print_gateway_agent_jobs", { tenantId, agentId: "ws-authority-agent", jobId: "job-a" });
    expect(state.claim).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(getAgentWsCount("ws-authority-agent")).toBe(1));
    if (received) {
      const [frame] = await received;
      expect(JSON.parse(frame.toString()).job.id).toBe("job-a");
      expect(state.claim).toHaveBeenCalledOnce();
    } else {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(state.claim).not.toHaveBeenCalled();
    }
  });
});
