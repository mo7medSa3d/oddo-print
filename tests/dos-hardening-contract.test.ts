import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("DoS/resource exhaustion hardening contracts", () => {
  it("does not trust an arbitrary X-API-Key header as authenticated", () => {
    const guard = read("src/server/request-guard.ts");
    expect(guard).toContain('startsWith("odoo_")');
    expect(guard).toContain('apiKeyHeader.trim().startsWith("odoo_") && apiKeyHeader.trim().length >= 16');
    expect(guard).not.toContain('token.includes(":") && token.length >= 10');
  });

  it("bounds per-agent queued count and payload memory", () => {
    const service = read("src/lib/print-job-service.ts");
    expect(service).toContain("MAX_AGENT_QUEUED_JOBS = 256");
    expect(service).toContain("MAX_AGENT_QUEUED_PAYLOAD_BYTES = 128 * 1024 * 1024");
    expect(service).toContain("pg_column_size(payload)");
    expect(service).toContain('Buffer.byteLength(JSON.stringify(validatedPayload), "utf8")');
  });

  it("bounds expensive jobs pagination and search input", () => {
    const route = read("src/app/api/jobs/route.ts");
    expect(route).toContain("MAX_LIST_OFFSET = 10_000");
    expect(route).toContain("MAX_SEARCH_LENGTH = 64");
    expect(route).toContain("offset must be <=");
  });

  it("adds indexes for high-frequency DoS-sensitive job admission/list queries", () => {
    const schema = read("src/db/schema.ts");
    expect(schema).toContain("print_jobs_tenant_created_idx");
    expect(schema).toContain("print_jobs_tenant_agent_status_expiry_idx");
    const migration = read("drizzle/0042_dos_indexes.sql");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS print_jobs_tenant_created_idx");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS print_jobs_tenant_agent_status_expiry_idx");
  });

  it("bounds discovery report amplification and batches persistence", () => {
    const discovery = read("src/app/api/agent/discovery/route.ts");
    expect(discovery).toContain("MAX_DISCOVERY_DEVICES = 1000");
    expect(discovery).toContain("DISCOVERY_INSERT_BATCH = 250");
    expect(discovery).toContain("Too many devices in one discovery report");
    expect(discovery).toContain("rows.slice(i, i + DISCOVERY_INSERT_BATCH)");
  });

  it("prevents one blocked printer from consuming all Agent pending capacity", () => {
    const agent = read("agent/internal/agent/agent.go");
    expect(agent).toContain("maxPendingJobsPerPrinter = 8");
    expect(agent).toContain("pendingByPrinter");
    expect(agent).toContain("printer_pending_full");
  });

  it("bounds WebSocket connection/message resource consumption", () => {
    const ws = read("src/server/ws.ts");
    expect(ws).toContain("MAX_TOTAL_AGENT_SOCKETS = 4096");
    expect(ws).toContain("MAX_WS_INFLIGHT_MESSAGES_PER_AGENT = 16");
    expect(ws).toContain('wss = new WebSocketServer({ noServer: true, path: "/api/agent/ws", maxPayload: MAX_WS_MESSAGE_BYTES })');
  });
});
