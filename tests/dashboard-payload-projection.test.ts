import { readFileSync } from "node:fs";
import { gatewayTestSigningKey } from "./helpers/test-secrets";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  closePool,
  seedFixture,
  insertQueuedJob,
  pool,
} from "./helpers/pg";
import { printerPresentation } from "../src/shared/printer-presentation";
import { isVirtualPrinterRecord, type PrinterLike } from "../src/lib/printer-virtual";
import { nonVirtualPrinterPredicate } from "../src/lib/printer-virtual-sql";
import { db } from "../src/db";
import { sql } from "drizzle-orm";
import { createManagerSession } from "../src/lib/manager-auth";
import type { Fixture } from "./helpers/pg";

let currentManagerToken: string | null = null;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (_name: string) => (currentManagerToken ? { value: currentManagerToken } : undefined),
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Import actions after mocks (same ordering as agent-deletion.test.ts)
import { getDashboardState, getDashboardJobs } from "../src/app/actions";

const suite = describe.skipIf(!hasTestDatabase);

describe("dashboard diagnostic payload loading contract", () => {
  it("shows loading only while the details request is actually in flight", () => {
    const source = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
    expect(source).toContain('if (payload === undefined) return t("job.noPayload")');
    expect(source).not.toContain('if (payload === undefined) return t("loading.payload")');
    expect(source).toContain('selectedJobPayloadLoading');
    expect(source).toContain('? t("loading.payload")');
    expect(source).toContain('setSelectedJobPayloadLoading(true)');
    expect(source).toContain('setSelectedJobPayloadLoading(false)');
    expect(source).toContain('retrySelectedJobPayload');
    expect(source).toContain('setSelectedJobPayloadReloadKey((key) => key + 1)');
    expect(source).toContain('{t("common.retry")}');
    expect(source).toContain("?includePayload=1");
  });
});

// Audit P1-02 regression: the dashboard 50-row list (page.tsx initial props
// AND the getDashboardState poll payload) must be metadata-only. Full
// payloads (base64 documents, multi-MB per job) remain server-side. The
// inspector fetches one job explicitly with includePayload=1; list/poll queries remain metadata-only.
suite("dashboard list queries never carry full job payloads", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = gatewayTestSigningKey();
    process.env.MANAGER_USERNAME = "manager";
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    const session = await createManagerSession(fixture.tenantId);
    currentManagerToken = session.token;
  });

  it("getDashboardState returns jobs without the payload column", async () => {
    await insertQueuedJob(fixture, "job_payload_probe_1");
    const state = await getDashboardState();
    expect(state.jobs.length).toBeGreaterThan(0);
    for (const job of state.jobs) {
      expect(job).not.toHaveProperty("payload");
      expect(job.id).toBe("job_payload_probe_1");
    }
  });

  it("getDashboardJobs returns jobs without the payload column", async () => {
    await insertQueuedJob(fixture, "job_payload_probe_2");
    const rows = await getDashboardJobs({ limit: 50 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("payload");
    }
  });

  it("keeps owner evidence on a printer page even when its Agent is outside the visible page", async () => {
    await pool().query("UPDATE printers SET status = 'busy' WHERE tenant_id = $1", [fixture.tenantId]);
    const state = await getDashboardState({ agentOffset: 100 });
    expect(state.agents).toEqual([]);
    expect(state.fleet.onlinePrinters).toBe(1);
    expect(state.printers[0]).toMatchObject({ agentId: fixture.agentId, agentStatus: "online", agentLifecycle: "active", inventoryPresent: true });
    expect(printerPresentation(state.printers[0], undefined).state).toBe("printing");
  });

  it("finds the Windows queue name shown for a legacy opaque printer label", async () => {
    await pool().query("UPDATE printers SET name = id, config = $1::jsonb WHERE tenant_id = $2", [JSON.stringify({ spooler_name: "Canon G4070", address: "Canon G4070" }), fixture.tenantId]);
    const state = await getDashboardState({ printerSearch: "Canon G4070" });
    expect(state.printers.map((printer) => printer.id)).toEqual([fixture.printerId]);
  });

  it("keeps removed or disabled devices in Saved without counting them as the current printer fleet", async () => {
    for (const update of ["inventory_present = false", "inventory_present = true, lifecycle = 'disabled'"]) {
      await pool().query(`UPDATE printers SET ${update} WHERE tenant_id = $1`, [fixture.tenantId]);
      const current = await getDashboardState();
      expect(current.printers).toEqual([]);
      expect(current.fleet).toMatchObject({ totalPrinters: 0, onlinePrinters: 0, savedPrinters: 1 });
      const saved = await getDashboardState({ printerStatus: "saved" });
      expect(saved.printers.map((printer) => printer.id)).toEqual([fixture.printerId]);
    }
  });

  it("filters the four simple states using current Agent and printer evidence without altering raw health", async () => {
    for (const [id, status, age] of [
      ["busy", "busy", "1 second"], ["offline", "offline", "1 second"], ["error", "error", "1 second"],
      ["unknown", "unknown", "1 second"], ["stale", "online", "1 hour"],
    ]) {
      await pool().query(
        "INSERT INTO printers (id, tenant_id, agent_id, name, status, last_seen_at) VALUES ($1,$2,$3,$1,$4,now() - $5::interval)",
        [id, fixture.tenantId, fixture.agentId, status, age],
      );
    }
    const expected = { ready: [fixture.printerId], printing: ["busy"], attention: ["error", "offline"], unavailable: ["stale", "unknown"] };
    for (const [filter, ids] of Object.entries(expected)) {
      const state = await getDashboardState({ printerStatus: filter });
      expect(state.printers.map((printer) => printer.id).sort()).toEqual([...ids].sort());
      expect(state.printers.every((printer) => printerPresentation(printer, undefined).state === filter)).toBe(true);
    }
    await pool().query("UPDATE agents SET last_seen_at = now() - interval '1 hour' WHERE id = $1", [fixture.agentId]);
    const unavailable = await getDashboardState({ printerStatus: "unavailable" });
    expect(unavailable.printers).toHaveLength(6);
    expect(unavailable.fleet.onlinePrinters).toBe(0);
    expect(unavailable.printers.find((printer) => printer.id === "offline")?.status).toBe("offline");
    expect(unavailable.printers.every((printer) => printerPresentation(printer, undefined).state === "unavailable")).toBe(true);
  });

  it("keeps bounded dashboard rows, filters and counts in parity with the shared legacy printer guard", async () => {
    const cases: PrinterLike[] = [
      { config: { spooler_name: "Microsoft Print to PDF" } },
      { config: { spoolerName: "Canon G4070 series FAX" } },
      { config: { display_name: "HP LaserJet (redirected 3)" } },
      { capabilities: { spoolerName: "Microsoft XPS Document Writer" } },
      { capabilities: { displayName: "OneNote" } },
      { capabilities: { displayName: "HP LaserJet redirected)" } },
      { capabilities: { displayName: "HP LaserJet (from WKS12) in session4" } },
      { capabilities: { port_name: "PORTPROMPT:" } },
      { capabilities: { port_name: "", portName: "PORTPROMPT:" } },
      { capabilities: { port_name: null, portName: "PORTPROMPT:" } },
      { capabilities: { port_name: { label: "USB001" }, portName: "PORTPROMPT:" } },
      { capabilities: { printer_class: "physical", printerClass: "virtual" } },
      { capabilities: { printer_class: null, printerClass: "virtual" } },
      { capabilities: { printer_class: { value: "physical" }, printerClass: "virtual" } },
      { capabilities: { printer_class: "\tVIRTUAL\n" } },
      { capabilities: { printer_class: "\u00a0redirected\u00a0" } },
      { capabilities: { is_virtual: "true" } },
      { capabilities: { is_virtual: "\tTRUE\n" } },
      { capabilities: { virtual: "false" } },
      { config: { virtual_test_sink: false } },
      { capabilities: { compatibleIds: ["Remote Desktop Easy Print"] } },
      { capabilities: { hardware_ids: [13, { driver: "Microsoft Print to PDF" }, false] } },
      { capabilities: { driver_name: { text: "Microsoft Print to PDF" } } },
      { capabilities: ["virtual_test_sink"] },
      { config: ["virtual_test_sink"] },
      { config: { spooler_name: "Canon G4070 series" } },
      { config: { spooler_name: "Canon G4070 series FAX\u00a0" } },
      { connectionType: "network", protocol: "raw", config: { address: "pdfcreator.example:9100" } },
      { connectionType: "usb", protocol: "spooler", config: { address: "Microsoft Print to PDF" } },
    ];
    for (const record of cases) {
      const row = { name: "Office alias", printerType: "physical", connectionType: "spooler", protocol: "spooler", ...record };
      const expected = isVirtualPrinterRecord(row) ? 0 : 1;
      // Evaluate legacy shapes without weakening the table's stronger CHECK.
      const result = await db.execute(sql`SELECT ${nonVirtualPrinterPredicate()} AS allowed
        FROM (SELECT ${row.name}::text AS name, ${row.printerType}::text AS printer_type,
          ${row.connectionType}::text AS connection_type, ${row.protocol}::text AS protocol,
          ${JSON.stringify(row.config ?? null)}::jsonb AS config,
          ${JSON.stringify(row.capabilities ?? null)}::jsonb AS capabilities) AS printers`);
      expect(result.rows[0]?.allowed, JSON.stringify(row)).toBe(expected === 1);
    }
    await expect(pool().query(
      "UPDATE printers SET config=$1::jsonb WHERE id=$2",
      [JSON.stringify({ spooler_name: "Microsoft Print to PDF" }), fixture.printerId],
    )).rejects.toMatchObject({ code: "23514" });
    // These historical aliases are legal under the existing DB CHECK;
    // the shared guard must still keep pages and counts consistent.
    for (const record of [
      { capabilities: { spoolerName: "Microsoft XPS Document Writer" } },
      { capabilities: { displayName: "OneNote" } },
      { config: { spoolerName: "Canon G4070 series FAX" } },
      { config: { display_name: "HP LaserJet (redirected 3)" } },
      { capabilities: { is_virtual: "true" } },
      { capabilities: { printer_class: null, printerClass: "virtual" } },
      { capabilities: { port_name: "", portName: "PORTPROMPT:" } },
      { config: { spooler_name: "Canon G4070 series" } },
      { connectionType: "network", protocol: "raw", config: { address: "canon.local:9100" } },
    ] as PrinterLike[]) {
      const row = { name: "Office alias", printerType: "physical", connectionType: "spooler", protocol: "spooler", ...record };
      const expected = isVirtualPrinterRecord(row) ? 0 : 1;
      await pool().query(
        "UPDATE printers SET name=$1, connection_type=$2, protocol=$3, config=$4::jsonb, capabilities=$5::jsonb, inventory_present=true WHERE id=$6",
        [row.name, row.connectionType, row.protocol, JSON.stringify(row.config ?? null), JSON.stringify(row.capabilities ?? null), fixture.printerId],
      );
      for (const printerStatus of ["all", "ready"]) {
        const state = await getDashboardState({ printerStatus });
        expect(state.printers, JSON.stringify(row)).toHaveLength(expected);
        expect(state.fleet, JSON.stringify(row)).toMatchObject({ totalPrinters: expected, onlinePrinters: expected });
        expect(state.agents[0]?.currentPrinterCount, JSON.stringify(row)).toBe(expected);
        expect(state.agents[0]?.printerCount).toBe(1);
      }
      await pool().query("UPDATE printers SET inventory_present=false WHERE id=$1", [fixture.printerId]);
      const saved = await getDashboardState({ printerStatus: "saved" });
      expect(saved.printers, JSON.stringify(row)).toHaveLength(expected);
      expect(saved.fleet.savedPrinters, JSON.stringify(row)).toBe(expected);
      expect(saved.agents[0]?.currentPrinterCount).toBe(0);
      expect(saved.agents[0]?.printerCount).toBe(1);
    }
  });
});
