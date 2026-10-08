import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrintJobForPrinter } from "../src/lib/print-job-service";
import { GET as pollAgentJobs } from "../src/app/api/agent/jobs/route";
import { applyMigrations, closePool, hasTestDatabase, pool, seedFixture, truncateAll, type Fixture } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);
const pdf = { type: "pdf", encoding: "base64", data: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 R>>\n%%EOF\n").toString("base64") };

suite("virtual capture print-job admission", () => {
  let f: Fixture;

  beforeAll(applyMigrations);
  afterAll(closePool);
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
    await pool().query(`
      UPDATE printers
      SET printer_type = 'virtual', connection_type = 'spooler', protocol = 'spooler',
          name = 'Yaseir Virtual Test Printer',
          capabilities = '{"virtual_test_sink":true,"registration_source":"config","supported_protocols":["pdf"]}'::jsonb,
          status = 'online', inventory_present = true, lifecycle = 'active', last_seen_at = now()
      WHERE id = $1 AND tenant_id = $2
    `, [f.printerId, f.tenantId]);
  });

  it("rejects virtual printers by default and keeps Odoo and reprints blocked when enabled", async () => {
    const testOptions = {
      tenantId: f.tenantId, requestedBy: "manager-test", documentType: "test_page",
      allowVirtualTestCapture: true,
    };
    await expect(createPrintJobForPrinter(f.printerId, pdf, testOptions))
      .rejects.toMatchObject({ code: "PRINTER_VIRTUAL" });
    vi.stubEnv("YASEIR_GATEWAY_VIRTUAL_TEST_MODE", "1");
    await expect(createPrintJobForPrinter(f.printerId, pdf, { ...testOptions, allowVirtualTestCapture: false }))
      .rejects.toMatchObject({ code: "PRINTER_VIRTUAL" });
    await expect(createPrintJobForPrinter(f.printerId, pdf, { ...testOptions, requestedBy: "odoo", documentType: "invoice" }))
      .rejects.toMatchObject({ code: "PRINTER_VIRTUAL" });
    await expect(createPrintJobForPrinter(f.printerId, pdf, { ...testOptions, reprintOfJobId: "job_original" }))
      .rejects.toMatchObject({ code: "PRINTER_VIRTUAL" });
    const count = await pool().query("SELECT COUNT(*)::int AS count FROM print_jobs WHERE printer_id=$1", [f.printerId]);
    expect(count.rows[0].count).toBe(0);
  });

  it("hands an explicitly authorized virtual test job to the real Agent polling endpoint", async () => {
    vi.stubEnv("YASEIR_GATEWAY_VIRTUAL_TEST_MODE", "1");
    const job = await createPrintJobForPrinter(f.printerId, pdf, {
      tenantId: f.tenantId, requestedBy: "manager-test", documentType: "test_page",
      allowVirtualTestCapture: true,
    });
    const response = await pollAgentJobs(new Request("http://gateway.test/api/agent/jobs", {
      method: "GET", headers: { Authorization: f.agentAuth, "content-type": "application/json" },
    }));
    expect(response.status).toBe(200);
    const jobs = await response.json() as Array<{ id: string; printerId?: string }>;
    expect(jobs.some((claimed) => claimed.id === job.id)).toBe(true);
    const actual = (await pool().query("SELECT status, delivery_attempts FROM print_jobs WHERE id=$1", [job.id])).rows[0];
    expect(actual.status).toBe("claimed");
    expect(Number(actual.delivery_attempts)).toBe(1);
  });

  it("accepts only the explicitly tagged Manager test print when opted in", async () => {
    vi.stubEnv("YASEIR_GATEWAY_VIRTUAL_TEST_MODE", "1");
    const result = await createPrintJobForPrinter(f.printerId, pdf, {
      tenantId: f.tenantId, requestedBy: "manager-test", documentType: "test_page",
      allowVirtualTestCapture: true,
    });
    expect(result.status).toBe("queued");
    const rows = (await pool().query("SELECT requested_by, document_type, status FROM print_jobs WHERE id=$1", [result.id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requested_by: "manager-test", document_type: "test_page", status: "queued" });
  });
});
