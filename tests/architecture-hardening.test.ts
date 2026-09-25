import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canTransitionLifecycle, lifecycleAllowsNewJobs } from "../src/lib/lifecycle";
import { printerInputSchema } from "../src/lib/printer-model";
import { validatePrintJobPayload } from "../src/lib/payload";

const b64 = (value: string) => Buffer.from(value, "binary").toString("base64");

describe("architecture hardening", () => {
  it("keeps agent management runtime-only and rejects branch ownership fields", async () => {
    const source = await import("node:fs/promises");
    const body = await source.readFile(new URL("../src/app/api/agents/route.ts", import.meta.url), "utf8");
    expect(body).not.toContain("branchId");
    expect(body).not.toContain("Default Branch");
    expect(body).toContain("createAgentSchema");
  });

  it("enforces terminal retired lifecycle", () => {
    expect(canTransitionLifecycle("active", "disabled")).toBe(true);
    expect(canTransitionLifecycle("disabled", "active")).toBe(true);
    expect(canTransitionLifecycle("active", "retired")).toBe(true);
    expect(canTransitionLifecycle("retired", "active")).toBe(false);
    expect(canTransitionLifecycle("retired", "disabled")).toBe(false);
    expect(lifecycleAllowsNewJobs("retired")).toBe(false);
    expect(lifecycleAllowsNewJobs("disabled")).toBe(false);
  });

  it("rejects legacy branch-owned printer input instead of normalizing it", () => {
    expect(printerInputSchema.safeParse({
      agentId: "agt_1", name: "P", printerType: "physical", deviceClass: "thermal", connectionType: "network", protocol: "raw",
      config: { ip: "127.0.0.1", port: 9100 }, branchId: "evil",
    }).success).toBe(false);
  });

  it("validates supported payload representations", () => {
    expect(validatePrintJobPayload({ type: "pdf", encoding: "base64", data: b64("%PDF-1.7\n") }).type).toBe("pdf");
    expect(validatePrintJobPayload({ type: "image", encoding: "base64", data: "/9j/4AAQSkZJRg==" }).type).toBe("image");
  });

  it("keeps the runtime printer schema canonical", () => {
    const result = printerInputSchema.safeParse({
      agentId: "agt_1", name: "P", printerType: "physical", deviceClass: "laser", connectionType: "spooler", protocol: "spooler",
      config: { spooler_name: "P" }, type: "spooler",
    });
    expect(result.success).toBe(false);
  });

  it("uses pairing code as the registration credential without Odoo business ownership", () => {
    const src = readFileSync("src/app/api/agent/register/route.ts", "utf8");
    expect(src).toContain("pairingCode");
    expect(src).toContain("hashPairingCode");
    expect(src).toContain("agentId: z.string().trim().min(1).max(120).optional()");
    expect(src).not.toContain("branchId");
    // Registration now uses a parameterized SQL predicate directly rather than
    // Drizzle's object-level eq() helper. Keep the contract on the credential
    // itself, not on an incidental query-builder syntax.
    expect(src).toContain("WHERE pairing_code_hash = ${hashedCode}");
    expect(src).toContain("agentId: agent.id");
    // The external snake_case response is derived from the transaction outcome,
    // after the pairing transaction has atomically consumed the credential.
    expect(src).toContain("agent_id: outcome.agentId");
    expect(src).toContain("agent_secret: outcome.secret");
  });

  it("declares discovered_devices.device_class NOT NULL and ships the reconciling migration", () => {
    // The runtime schema is the documented source of truth, so every .notNull()
    // it declares must be enforced by the migration chain. device_class was once
    // created nullable by 0010 while schema.ts already declared notNull(); a
    // later reconciliation migration closes that gap and a regression here would
    // re-open the schema/code drift.
    const schema = readFileSync("src/db/schema.ts", "utf8");
    expect(schema).toContain('deviceClass: text("device_class").notNull().default("unknown")');
    const migration = readFileSync("drizzle/0056_discovered_device_class_not_null.sql", "utf8");
    expect(migration).toContain('UPDATE "discovered_devices"');
    expect(migration).toContain("SET \"device_class\" = 'unknown'");
    expect(migration).toContain('ALTER TABLE "discovered_devices" ALTER COLUMN "device_class" SET NOT NULL');
  });

  it("installs security headers without forcing HSTS on development HTTP", () => {
    const src = readFileSync("next.config.ts", "utf8");
    const proxy = readFileSync("proxy.ts", "utf8");
    expect(src).toContain("X-Content-Type-Options");
    expect(src).toContain("strict-origin-when-cross-origin");
    expect(src).toContain("X-Frame-Options");
    expect(src).toContain("Permissions-Policy");
    expect(src).toContain("NODE_ENV === \"production\"");
    expect(src).toContain("Strict-Transport-Security");
    expect(src).not.toContain("Content-Security-Policy");
    expect(src).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(proxy).not.toMatch(/script-src[^;]*unsafe-inline/);
    const csp = readFileSync("src/server/content-security-policy.ts", "utf8");
    expect(csp).toContain("connect-src 'self';");
  });

  it("uses a request-scoped CSP nonce for the only application inline script", () => {
    const proxy = readFileSync("proxy.ts", "utf8");
    const server = readFileSync("server.ts", "utf8");
    const csp = readFileSync("src/server/content-security-policy.ts", "utf8");
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(csp).toContain("crypto.randomUUID()");
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(proxy).toContain('requestHeaders.set("x-nonce", nonce)');
    expect(proxy).toContain('response.headers.set("Content-Security-Policy", policy)');
    expect(server).toContain("createRequestContentSecurityPolicy");
    expect(server).toContain('req.headers["x-nonce"] = nonce');
    expect(server).toContain('res.setHeader("Content-Security-Policy", policy)');
    expect(csp).toContain("crypto.randomUUID()");
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("connect-src 'self';");
    expect(layout).toContain("const THEME_INIT =");
    expect(layout).toContain('const nonce = (await headers()).get("x-nonce")');
    expect(layout).toContain("<script nonce={nonce}");
    expect(layout).toContain('localStorage.getItem("theme")');
  });

  it("keeps agent lifecycle changes transactional in ONE shared implementation", () => {
    // The lifecycle flow lives in exactly one place (src/lib/agent-lifecycle.ts)
    // which BOTH the route and the server action call; a second divergent copy
    // reintroduced the credential-destroying no-op bug once already.
    const src = readFileSync("src/lib/agent-lifecycle.ts", "utf8");
    const block = src.slice(src.indexOf("export async function transitionAgentLifecycle"));
    expect(block).toContain("db.transaction");
    expect(block).toContain("tx.update(agents)");
    // Printer desired lifecycle is manager-owned and must not be mutated by
    // Agent lifecycle transitions.
    expect(block).not.toContain("tx.update(printers)");
    // No-op guard: current === next must not rotate credentials.
    expect(block).toContain("if (current === next)");
    for (const consumer of ["src/app/actions.ts", "src/app/api/agents/[id]/route.ts"]) {
      expect(readFileSync(consumer, "utf8")).toContain("transitionAgentLifecycle");
    }
  });

  it("keeps permanent agent deletion transactional with row-level locking and audit protection", () => {
    const src = readFileSync("src/app/actions.ts", "utf8");
    const start = src.indexOf("export async function deleteAgent");
    const end = src.indexOf("export async function createPrintJob", start);
    const block = src.slice(start, end);
    expect(block).toContain("requireManager()");
    expect(block).toContain("db.transaction");
    expect(block).toContain("FOR UPDATE");
    expect(block).toContain("tx.delete(agents)");
    expect(block).toContain("pg_notify('print_gateway_agent_sessions'");
  });
  it("does not introduce an unsigned Tauri updater path", () => {
    const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
    const config = readFileSync("src-tauri/tauri.conf.json", "utf8");
    const main = readFileSync("src-tauri/src/main.rs", "utf8");
    expect(cargo).not.toContain("tauri-plugin-updater");
    expect(main).not.toContain("tauri_plugin_updater");
    expect(config).not.toMatch(/"updater"\s*:/);
  });

  it("keeps external failure outcomes explicit instead of assuming success", () => {
    const webhook = readFileSync("src/app/api/billing/webhook/route.ts", "utf8");
    expect(webhook).toContain("ON CONFLICT (event_id) DO NOTHING");
    expect(webhook).toContain("Unable to verify current Stripe subscription state");
    expect(webhook).toContain("return NextResponse.json({ error: \"Unable to verify current Stripe subscription state\" }, { status: 502 });");

    const ws = readFileSync("src/server/ws.ts", "utf8");
    expect(ws).toContain("releaseUndeliveredClaim");
    expect(ws).toContain("markJobDeliveryUnknown");
    const evidenceStart = ws.indexOf("const evidenced = await markJobDelivered");
    const evidenceEnd = ws.indexOf('return markedUnknown ? "delivery_unknown" : "not_claimable";', evidenceStart);
    expect(evidenceStart).toBeGreaterThanOrEqual(0);
    expect(evidenceEnd).toBeGreaterThan(evidenceStart);
    expect(ws.slice(evidenceStart, evidenceEnd)).toContain("markJobDeliveryUnknown");

    const odoo = readFileSync("odoo_addons/print_gateway/models/print_job.py", "utf8");
    expect(odoo).toContain("UNKNOWN_SUBMISSION_OUTCOME:");
    expect(odoo).toContain("Automated retries are paused to prevent duplicate prints.");
    expect(odoo).toContain('failed_jobs = self.filtered(lambda row: row.status == "failed" and row.physical_outcome == "not_printed")');
    expect(odoo).toContain("GATEWAY_JOB_NOT_FOUND:");
  });

});
